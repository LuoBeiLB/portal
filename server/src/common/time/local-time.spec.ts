import { instantToWallIso, resolveDisplayTzOffset, timezoneOffsetMinutes, toWallIso } from './local-time';

/**
 * 展示时区偏移必须来自**配置**，不能取自进程时区。
 *
 * 这条 bug 的形态是「本地全绿、公网错 8 小时」：开发机 Node 时区是 +08，
 * `getTimezoneOffset()` 返回 -480，补偏移恰好正确；公网 Linux 是 UTC 返回 0，
 * 于是应用写列（reviewed_at / paid_at / expire_at / last_sync_at）全部少 8 小时。
 * 本地永远复现不了 —— 所以偏移必须可注入、可断言。
 */
describe('展示时区偏移（DISPLAY_TZ_OFFSET_MINUTES）', () => {
  const original = process.env.DISPLAY_TZ_OFFSET_MINUTES;

  afterEach(() => {
    if (original === undefined) delete process.env.DISPLAY_TZ_OFFSET_MINUTES;
    else process.env.DISPLAY_TZ_OFFSET_MINUTES = original;
  });

  describe('resolveDisplayTzOffset —— 配置解析', () => {
    it('未配置时默认东八区 480', () => {
      expect(resolveDisplayTzOffset(undefined)).toBe(480);
      expect(resolveDisplayTzOffset(null)).toBe(480);
      expect(resolveDisplayTzOffset('')).toBe(480);
      expect(resolveDisplayTzOffset('   ')).toBe(480);
    });

    it('接受合法分钟数，含负偏移与上下界', () => {
      expect(resolveDisplayTzOffset('480')).toBe(480);
      expect(resolveDisplayTzOffset('0')).toBe(0);
      expect(resolveDisplayTzOffset('-300')).toBe(-300); // UTC-5
      expect(resolveDisplayTzOffset('840')).toBe(840); // UTC+14 上界
      expect(resolveDisplayTzOffset('-720')).toBe(-720); // UTC-12 下界
    });

    it('非法值回落默认，避免一个笔误把全站时间带偏', () => {
      expect(resolveDisplayTzOffset('abc')).toBe(480);
      expect(resolveDisplayTzOffset('8h')).toBe(480);
      expect(resolveDisplayTzOffset('NaN')).toBe(480);
      expect(resolveDisplayTzOffset('1200')).toBe(480); // 超出 +14:00
      expect(resolveDisplayTzOffset('-800')).toBe(480); // 超出 -12:00
    });
  });

  describe('instantToWallIso —— 应用写列出口（需要补偏移）', () => {
    // 库里存的是应用写的 UTC 墙面 05:50:40，真实时刻就是 UTC 05:50:40
    const utcWall = new Date('2026-10-15T05:50:40Z');

    it('东八区：补 8 小时 → 13:50:40（开发机上的正确结果）', () => {
      process.env.DISPLAY_TZ_OFFSET_MINUTES = '480';
      expect(instantToWallIso(utcWall)).toBe('2026-10-15T13:50:40Z');
    });

    it('偏移为 0（公网 UTC 的旧行为）：原样输出 05:50:40 —— 把 bug 形态钉成断言', () => {
      process.env.DISPLAY_TZ_OFFSET_MINUTES = '0';
      // 这条不是认可该结果，而是固定住"偏移取错会得到什么"，
      // 防止有人又把偏移来源改回 new Date().getTimezoneOffset()
      expect(instantToWallIso(utcWall)).toBe('2026-10-15T05:50:40Z');
    });

    it('空值返回 null', () => {
      process.env.DISPLAY_TZ_OFFSET_MINUTES = '480';
      expect(instantToWallIso(null)).toBeNull();
      expect(instantToWallIso(undefined)).toBeNull();
    });
  });

  describe('toWallIso —— 库生成列出口（永不补偏移）', () => {
    it('任何偏移配置下都原样读 UTC 分量', () => {
      const dbGenerated = new Date('2026-10-15T13:48:24Z');
      process.env.DISPLAY_TZ_OFFSET_MINUTES = '480';
      expect(toWallIso(dbGenerated)).toBe('2026-10-15T13:48:24Z');
      process.env.DISPLAY_TZ_OFFSET_MINUTES = '0';
      expect(toWallIso(dbGenerated)).toBe('2026-10-15T13:48:24Z');
    });
  });

  it('timezoneOffsetMinutes 读配置而不是进程时区', () => {
    process.env.DISPLAY_TZ_OFFSET_MINUTES = '0';
    expect(timezoneOffsetMinutes()).toBe(0);
    process.env.DISPLAY_TZ_OFFSET_MINUTES = '480';
    expect(timezoneOffsetMinutes()).toBe(480);
    delete process.env.DISPLAY_TZ_OFFSET_MINUTES;
    expect(timezoneOffsetMinutes()).toBe(480); // 默认值兜底
  });
});
