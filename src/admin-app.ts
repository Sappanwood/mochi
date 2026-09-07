export interface AdminLogin {
  token(interactive: boolean): Promise<string | null>;
  logout(): Promise<void>;
}

export function mountAdmin(login: AdminLogin) {
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const message = byId('message'); const panel = byId('providers');
  let session = ''; let transaction = ''; let poll: ReturnType<typeof setTimeout> | undefined;
  const describe: Record<string, string> = {
    unauthorized: '登录已过期，请重新登录。', forbidden: '此账号没有管理权限。',
    provider_busy: '认证操作正在进行，请完成或取消后再试。', invalid_key: 'API key 格式无效。',
    not_ready: '认证存储暂不可用，请稍后重试。', operation_failed: '操作失败，请检查认证状态后重试。',
    reauthentication_required: '订阅认证未通过验证，请重新登录 OpenAI。',
    session_limit: '管理会话过多，请等待旧会话过期。',
  };
  function show(text: string) { message.textContent = text; }
  async function api(path: string, method = 'GET', body?: object) {
    const token = await login.token(false);
    if (!token) throw new Error('unauthorized');
    const response = await fetch(path, { method, headers: {
      authorization: `Bearer ${token}`, 'x-mochi-request': '1', 'x-mochi-session': session,
      'content-type': 'application/json',
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'operation_failed');
    return result;
  }
  function failed(error: unknown) {
    const code = error instanceof Error ? error.message : '';
    show(describe[code] ?? '操作未完成，请重试。');
    if (code === 'unauthorized' || code === 'forbidden') {
      session = ''; panel.hidden = true; byId('signout').hidden = true;
      byId('signin').hidden = false; if (poll) clearTimeout(poll);
    }
  }
  async function refresh() {
    const data = await api('/admin/providers');
    for (const provider of data.providers) {
      const label = provider.configured ? '已保存认证 · 实际可用性待调用验证' : '未配置认证';
      byId(`${provider.provider}-status`).textContent = label;
    }
    const models = byId('models'); models.replaceChildren();
    for (const model of data.models) {
      const item = document.createElement('li'); item.textContent = `${model.provider} / ${model.id}`; models.append(item);
    }
  }
  async function signIn(interactive: boolean) {
    if (!await login.token(interactive)) return;
    const result = await api('/admin/session', 'POST', {});
    session = result.id; panel.hidden = false; byId('signout').hidden = false; byId('signin').hidden = true;
    show('已登录个人管理会话。'); await refresh();
  }
  byId<HTMLButtonElement>('signin').onclick = () => { void signIn(true).catch(failed); };
  byId<HTMLButtonElement>('signout').onclick = async () => {
    try { await api('/admin/session', 'DELETE', {}); }
    catch { /* Local state is cleared even if the server session has expired. */ }
    if (poll) clearTimeout(poll); session = ''; transaction = '';
    panel.hidden = true; byId('signin').hidden = false; byId('signout').hidden = true;
    byId('device').hidden = true; byId<HTMLInputElement>('key').value = '';
    try { await login.logout(); show('已退出管理会话。'); } catch { show('本地管理会话已清除。'); }
  };
  byId<HTMLFormElement>('key-form').onsubmit = async event => {
    event.preventDefault();
    const key = byId<HTMLInputElement>('key'); const value = key.value; key.value = '';
    try { await api('/admin/providers/deepseek/key', 'POST', { key: value }); show('DeepSeek API key 已保存。'); await refresh(); }
    catch (error) { failed(error); }
  };
  async function inspect() {
    const txn = await api(`/admin/oauth/${transaction}`);
    if (txn.state === 'authorizing') {
      byId('device').hidden = false;
      byId('device-code').textContent = txn.userCode ?? '正在获取设备码…';
      const link = byId<HTMLAnchorElement>('device-link');
      if (txn.verificationUri === 'https://auth.openai.com/codex/device') {
        link.href = txn.verificationUri; link.hidden = false;
      } else link.hidden = true;
      poll = setTimeout(() => { void inspect().catch(failed); }, 1000);
    } else {
      byId('device').hidden = true;
      const labels: Record<string, string> = { succeeded: 'OpenAI subscription 登录已保存。', cancelled: '授权已取消。', expired: '设备码已过期，请重新登录。', failed: '授权失败，请确认账号允许设备码登录后重试。' };
      show(labels[txn.state] ?? '授权未完成。'); transaction = ''; await refresh();
    }
  }
  byId<HTMLButtonElement>('openai-login').onclick = async () => {
    try { transaction = (await api('/admin/providers/openai-codex/login', 'POST', {})).id; show('请完成 OpenAI 设备码授权。'); await inspect(); }
    catch (error) { failed(error); }
  };
  byId<HTMLButtonElement>('openai-refresh').onclick = async () => {
    const button = byId<HTMLButtonElement>('openai-refresh');
    button.disabled = true; show('正在验证并刷新订阅认证…');
    try { await api('/admin/providers/openai-codex/refresh', 'POST', {}); show('订阅认证已刷新并保存；未调用模型。'); }
    catch (error) { failed(error); }
    finally { button.disabled = false; if (session) await refresh().catch(failed); }
  };
  byId<HTMLButtonElement>('cancel').onclick = async () => {
    try { await api(`/admin/oauth/${transaction}/cancel`, 'POST', {}); if (poll) clearTimeout(poll); await inspect(); }
    catch (error) { failed(error); }
  };
  for (const provider of ['deepseek', 'openai-codex']) byId<HTMLButtonElement>(`${provider}-logout`).onclick = async () => {
    try { await api(`/admin/providers/${provider}/logout`, 'POST', {}); show('已移除 provider 认证。'); await refresh(); }
    catch (error) { failed(error); }
  };
  byId<HTMLButtonElement>('refresh').onclick = () => { void refresh().catch(failed); };
  void signIn(false).catch(failed);
}
