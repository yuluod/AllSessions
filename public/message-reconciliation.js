// 签名包含语言、检索与完整消息状态；卡片复用不能保留过期操作参数。
export function planMessageUpdates(groups, cache, context) {
  return groups.map(({ message, result }) => {
    const key = message._message_key || String(message._origIdx);
    const signature = JSON.stringify([message, result, context]);
    const previous = cache.get(key);
    return {
      key,
      signature,
      previous,
      reuse: !context.regex && previous?.signature === signature,
    };
  });
}
