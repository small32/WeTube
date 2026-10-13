(() => {
  if (window.__wetubeShowAbout) return;
  let dialog, status, check, download, downloadUrl;
  const element = (tag, text) => {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  };
  const button = (text, onclick) => {
    const node = element('button', text);
    node.onclick = onclick;
    node.style.cssText = 'padding:6px 18px;background:#303030;color:#fff;border:1px solid #666;border-radius:4px;font:13px system-ui;cursor:pointer';
    return node;
  };
  window.__wetubeShowAbout = (info) => {
    if (dialog?.isConnected) { dialog.focus(); return; }
    dialog = document.createElement('dialog');
    dialog.style.cssText = 'background:#202020;color:#fff;border:1px solid #444;border-radius:8px;padding:0;width:380px;max-width:90vw;font:13px system-ui;z-index:2147483647;box-shadow:0 12px 48px #0008';
    dialog.setAttribute('aria-label', '关于 WeTube');
    const iconUrl = 'data:image/png;base64,' + btoa(String.fromCharCode(...info.icon));
    const icon = (size) => {
      const img = element('img', ''); img.src = iconUrl; img.alt = ''; img.width = img.height = size;
      return img;
    };
    const header = element('div', '');
    header.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px';
    const dismiss = button('×', () => dialog.close());
    dismiss.setAttribute('aria-label', '关闭');
    dismiss.style.cssText = 'margin-left:auto;border:0;background:transparent;color:#fff;font-size:20px;cursor:pointer';
    header.append(icon(16), element('span', '关于 WeTube'), dismiss);
    const body = element('div', ''); body.style.cssText = 'text-align:center;padding:24px 22px 18px';
    const heading = element('h2', 'WeTube'); heading.style.cssText = 'font-size:17px;margin:12px 0 20px';
    const details = element('p', `版本 ${info.version}`); details.style.margin = '4px 0 18px';
    const developer = element('p', `开发人：${info.developer}`);
    const project = element('a', info.project); project.href = info.project; project.style.cssText = 'color:#8ab4f8;text-decoration:none;overflow-wrap:anywhere';
    project.onclick = (e) => { e.preventDefault(); window.ipc.postMessage('open:' + info.project); };
    status = document.createElement('p'); status.setAttribute('role', 'status');
    status.style.cssText = 'margin:12px 0 0;line-height:1.5';
    check = button('检查更新', window.__wetubeCheckUpdate);
    download = button('更新', () => { window.ipc.postMessage('open:' + downloadUrl); status.textContent = '已通过默认浏览器开始下载，下载后请解压并替换当前应用。'; });
    download.hidden = true;
    const close = button('确定', () => dialog.close());
    close.style.borderColor = '#168bcc';
    const footer = element('div', '');
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding:10px 12px;border-top:1px solid #383838;background:#242424';
    body.append(icon(72), heading, developer, details, project, status);
    footer.append(check, download, close);
    dialog.append(header, body, footer);
    dialog.addEventListener('close', () => dialog.remove());
    document.documentElement.append(dialog); dialog.showModal();
  };
  window.__wetubeCheckUpdate = () => {
    if (!dialog?.isConnected || check.disabled) return;
    check.disabled = true; download.hidden = true; status.textContent = '正在检查 GitHub Release…';
    window.ipc.postMessage('check-update');
  };
  window.__wetubeUpdateResult = (result) => {
    if (!dialog?.isConnected) return;
    check.disabled = false;
    download.hidden = result.status !== 'available';
    downloadUrl = result.url;
    status.textContent = result.status === 'available' ? `发现新版本 ${result.version}，点击“更新”下载对应平台安装包。`
      : result.status === 'current' ? '当前已是最新版本。' : result.message;
  };
})();
