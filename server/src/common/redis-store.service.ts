import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

import { REDIS_CLIENT } from './redis.constants';

/**
 * Redis 轻量封装：统一异常处理与 JSON 序列化。
 *
 * 约定：**读路径失败返回 null（降级放行），写路径失败抛错**——
 * 会话写入失败必须让调用方知道（否则用户以为登录成功但刷新不了），
 * 而读取失败（Redis 抖动）不应把整个门户打死。
 */
@Injectable()
export class RedisStore {
  private readonly logger = new Logger(RedisStore.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (error) {
      this.logger.warn(`getJson 失败 key=${key}: ${(error as Error).message}`);
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error) {
      this.logger.error(`setJson 失败 key=${key}: ${(error as Error).message}`);
      throw error;
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.redis.del(...keys);
    } catch (error) {
      this.logger.warn(`del 失败 keys=${keys.join(',')}: ${(error as Error).message}`);
    }
  }

  /** 按前缀删除（登出：吊销该用户全部 refresh 会话） */
  async delByPrefix(prefix: string): Promise<number> {
    try {
      let cursor = '0';
      let removed = 0;
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
        cursor = next;
        if (keys.length > 0) {
          await this.redis.del(...keys);
          removed += keys.length;
        }
      } while (cursor !== '0');
      return removed;
    } catch (error) {
      this.logger.warn(`delByPrefix 失败 prefix=${prefix}: ${(error as Error).message}`);
      return 0;
    }
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  // ---------- 集合（用于「按用户吊销全部 refresh 会话」）----------

  async sadd(key: string, member: string, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.sadd(key, member);
      await this.redis.expire(key, ttlSeconds);
    } catch (error) {
      this.logger.warn(`sadd 失败 key=${key}: ${(error as Error).message}`);
    }
  }

  async smembers(key: string): Promise<string[]> {
    try {
      return await this.redis.smembers(key);
    } catch (error) {
      this.logger.warn(`smembers 失败 key=${key}: ${(error as Error).message}`);
      return [];
    }
  }

  async srem(key: string, member: string): Promise<void> {
    try {
      await this.redis.srem(key, member);
    } catch (error) {
      this.logger.warn(`srem 失败 key=${key}: ${(error as Error).message}`);
    }
  }
}
