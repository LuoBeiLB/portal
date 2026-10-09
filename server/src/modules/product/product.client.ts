import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';

import { PortalConfigService } from '../../config/portal-config.service';
import { ProductEndpoint } from '../../config/configuration';
import { BizException, ErrorCode } from '../../common/error-code';

/** 门户外呼产品时的统一响应外壳（契约 §5 要求产品响应套 `{code,data}`，与门户一致） */
interface ProductEnvelope<T> {
  code: number;
  message?: string;
  data?: T;
}

export interface RemoteProduct {
  sku_id: string;
  name: string;
  spec: Record<string, unknown>;
  price_cents: number;
  billing_mode: number;
  period_days?: number | null;
  stock?: number | null;
}

export interface ProvisionRequest {
  /** 幂等键：门户订单项 ID，产品侧必须持久化唯一索引 */
  order_item_id: string;
  portal_user_id: string;
  sku_id: string;
  quantity: number;
  period_days?: number | null;
  extra?: Record<string, unknown>;
}

export interface ProvisionResult {
  instance_id: string;
  expire_at: string | null;
  quantity: number;
}

/** 开通失败：区分「业务失败（不要重试）」与「系统失败（可重试）」 */
export class ProvisionError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProvisionError';
  }
}

/**
 * 产品侧接口客户端（契约 §5：门户 → 产品）。
 *
 * - `GET /internal/products` 拉商品目录（门户每 10 分钟全量 upsert）
 * - `POST /internal/provision` 开通（幂等键 order_item_id，30s 超时）
 *
 * 鉴权：`X-Internal-Key`，每产品一码。**仅内网调用**，产品侧应保证该路径不对公网暴露。
 */
@Injectable()
export class ProductClient {
  private readonly logger = new Logger(ProductClient.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: PortalConfigService,
  ) {}

  /** 已配置的产品端点 */
  endpoints(): ProductEndpoint[] {
    return this.config.products;
  }

  /**
   * 按产品代码取端点。
   *
   * ⚠️ 只配了密钥、未配地址的产品（`enabled = false`）也会在列表里（它需要参与入站鉴权），
   * 但**不能**用于出站调用 —— 这里显式拦住，避免拼出 `"http:///internal/products"` 这种空地址请求。
   */
  findByCode(productCode: string): ProductEndpoint {
    const endpoint = this.config.products.find((item) => item.code === productCode);
    if (!endpoint) throw new BizException(ErrorCode.PRODUCT_NOT_FOUND, `未配置产品 ${productCode} 的内网地址`);
    if (!endpoint.enabled || !endpoint.baseUrl) {
      throw new BizException(
        ErrorCode.PRODUCT_NOT_FOUND,
        `产品 ${productCode} 未配置内网地址（仅配置了入站密钥），无法出站调用`,
      );
    }
    return endpoint;
  }

  /** 契约 §5.1 商品目录 */
  async fetchProducts(productCode: string): Promise<RemoteProduct[]> {
    const endpoint = this.findByCode(productCode);
    const url = `${endpoint.baseUrl}/internal/products`;
    const response = await firstValueFrom(
      this.http.get<ProductEnvelope<{ products: RemoteProduct[] }>>(url, {
        timeout: this.config.shop.productTimeoutMs,
        headers: this.internalHeaders(endpoint),
      }),
    );

    const body = response.data;
    if (body?.code !== 0) {
      throw new Error(`产品 ${productCode} 返回 code=${body?.code}：${body?.message ?? ''}`);
    }
    return body.data?.products ?? [];
  }

  /**
   * 契约 §5.2 开通。
   * 产品返回非 0 code 时抛 ProvisionError：4003/4004 属业务失败（不重试），其余按系统失败可重试。
   */
  async provision(productCode: string, payload: ProvisionRequest): Promise<ProvisionResult> {
    const endpoint = this.findByCode(productCode);
    const url = `${endpoint.baseUrl}/internal/provision`;

    let response;
    try {
      response = await firstValueFrom(
        this.http.post<ProductEnvelope<ProvisionResult>>(url, payload, {
          timeout: this.config.shop.provisionTimeoutMs,
          headers: this.internalHeaders(endpoint),
        }),
      );
    } catch (error) {
      // 网络失败 / 超时 / 5xx：契约明确「以产品侧 provision 幂等结果为准」，用同一 order_item_id 重试
      const detail = describeAxiosError(error);
      throw new ProvisionError(true, 'NETWORK', `调用 ${productCode} provision 失败：${detail}`);
    }

    const body = response.data;
    if (body?.code !== 0) {
      const code = body?.code ?? ErrorCode.INTERNAL_ERROR;
      const retryable = code !== ErrorCode.PRODUCT_NOT_FOUND && code !== ErrorCode.STOCK_NOT_ENOUGH;
      throw new ProvisionError(
        retryable,
        String(code),
        `产品 ${productCode} 开通失败：code=${code} ${body?.message ?? ''}`,
      );
    }

    const data = body.data;
    if (!data?.instance_id) {
      throw new ProvisionError(true, 'BAD_RESPONSE', `产品 ${productCode} provision 未返回 instance_id`);
    }
    return {
      instance_id: data.instance_id,
      expire_at: data.expire_at ?? null,
      quantity: data.quantity ?? payload.quantity,
    };
  }

  private internalHeaders(endpoint: ProductEndpoint): Record<string, string> {
    if (!endpoint.internalKey) {
      this.logger.warn(`产品 ${endpoint.code} 未配置 X-Internal-Key，调用可能被拒`);
    }
    return {
      'content-type': 'application/json',
      'x-internal-key': endpoint.internalKey,
    };
  }
}

function describeAxiosError(error: unknown): string {
  const axiosError = error as AxiosError;
  if (axiosError?.code === 'ECONNABORTED' || axiosError?.code === 'ETIMEDOUT') return '请求超时';
  if (axiosError?.response) return `HTTP ${axiosError.response.status}`;
  return axiosError?.message ?? String(error);
}
