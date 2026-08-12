/**
 * 流式空闲超时保护（全量版与 lite 版 Worker 共用）
 *
 * 距上一次收到数据超过 idleMs 时终止流（流式响应专用）。
 * 与 fetch 的总超时不同：持续传输数据的正常长流不受影响，
 * 只有"上游挂起不吐数据"（如免费模型排队空转、连接半开）才会被切断，
 * 避免函数被无数据流无限占用（此前实测挂起可达 15 分钟）。
 */

/**
 * @param onTimeout 超时回调（用于补记请求日志；输入流正常结束时不会触发）
 */
export function withIdleTimeout(
  stream: ReadableStream<Uint8Array>,
  idleMs: number,
  onTimeout?: () => void
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const armTimer = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    clearTimer();
    timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      onTimeout?.();
      // 取消上游读取、释放上游连接（与 Pages 版看门狗 r.cancel() 行为对齐）；
      // pending read 会 reject 进入 start 的 catch，那里已做二次 error 防重入
      reader.cancel().catch(() => {});
      controller.error(new DOMException("上游响应空闲超时", "TimeoutError"));
    }, idleMs);
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      armTimer(controller);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            finished = true;
            clearTimer();
            controller.close();
            break;
          }
          armTimer(controller);
          controller.enqueue(value);
        }
      } catch (err) {
        finished = true;
        clearTimer();
        try {
          controller.error(err);
        } catch {
          // 超时路径已主动 error（reader.cancel 导致的 read reject），忽略二次 error
        }
      }
    },
    cancel(reason) {
      finished = true;
      clearTimer();
      return reader.cancel(reason);
    },
  });
}
