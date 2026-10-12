(() => {
  const pending = new Map();
  let counter = 0;
  const native = window.webkit?.messageHandlers?.hub;
  window.__hubReply = reply => {
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id); clearTimeout(waiter.timer);
    reply.ok ? waiter.resolve(reply.value) : waiter.reject(new Error(reply.error || 'The request failed.'));
  };
  const ready = native ? Promise.resolve() : new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/app/windows-host.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Open the Windows test preview with npm run hub:demo.'));
    document.head.append(script);
  });
  window.Hub = {
    async call(method, params = {}) {
      await ready;
      if (!native) return window.WindowsHubHost.call(method, params);
      return new Promise((resolve, reject) => {
        const id = String(++counter);
        const fileOperation = ['addFolder', 'scanDrive', 'importFiles', 'importEpisode', 'exportEpisode', 'prepareBulk'].includes(method);
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('The request timed out. Check the PC or connected drive before retrying.')); }, fileOperation ? 1800000 : method.startsWith('fetcher') ? 250000 : 35000);
        pending.set(id, { resolve, reject, timer });
        try { native.postMessage({ id, method, params }); }
        catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    }
  };
})();
