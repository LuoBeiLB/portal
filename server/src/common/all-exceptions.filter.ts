import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Response } from 'express';
import { QueryFailedError } from 'typeorm';

import { ErrorCode, BizException, ERROR_MESSAGES } from './error-code';

interface MysqlDriverError {
  code?: string;
  errno?: number;
  sqlMessage?: string;
}

/**
 * 全局异常 → 统一响应体。
 * 契约要求：除框架级 404/405 外，业务失败也返回 HTTP 200，业务码放 body。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof BizException) {
      response.status(exception.httpStatus).json({
        code: exception.code,
        message: exception.message,
        data: exception.data ?? null,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // 404/405 保留框架语义；其余按契约转业务码
      if (status === 404 || status === 405) {
        response.status(status).json({
          code: ErrorCode.INTERNAL_ERROR,
          message: exception.message,
          data: null,
        });
        return;
      }
      const payload = exception.getResponse();
      const errors = typeof payload === 'object' ? (payload as Record<string, unknown>).message : payload;
      response.status(200).json({
        code: ErrorCode.PARAM_INVALID,
        message: ERROR_MESSAGES[ErrorCode.PARAM_INVALID],
        data: { errors },
      });
      return;
    }

    if (exception instanceof QueryFailedError) {
      const driver = exception.driverError as MysqlDriverError;
      // 唯一键冲突：交给业务自行判定时通常已被捕获，这里兜底
      if (driver?.errno === 1062) {
        response.status(200).json({
          code: ErrorCode.PARAM_INVALID,
          message: '数据已存在（唯一约束冲突）',
          data: { constraint: driver.sqlMessage },
        });
        return;
      }
      this.logger.error(`DB error: ${driver?.sqlMessage ?? exception.message}`);
      response.status(200).json({
        code: ErrorCode.INTERNAL_ERROR,
        message: ERROR_MESSAGES[ErrorCode.INTERNAL_ERROR],
        data: null,
      });
      return;
    }

    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    response.status(200).json({
      code: ErrorCode.INTERNAL_ERROR,
      message: ERROR_MESSAGES[ErrorCode.INTERNAL_ERROR],
      data: null,
    });
  }
}
