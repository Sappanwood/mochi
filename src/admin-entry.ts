import { PublicClientApplication } from '@azure/msal-browser';
import { mountAdmin } from './admin-app.ts';

try {
  const response = await fetch('/admin/config');
  if (!response.ok) throw new Error();
  const config = await response.json();
  if (location.origin !== config.origin) throw new Error();
  const msal = new PublicClientApplication({
    auth: { clientId: config.clientId, authority: `https://login.microsoftonline.com/${config.tenant}`, redirectUri: `${config.origin}/` },
    cache: { cacheLocation: 'sessionStorage' },
  });
  await msal.initialize();
  const result = await msal.handleRedirectPromise();
  if (result?.account) msal.setActiveAccount(result.account);
  mountAdmin({
    async token(interactive) {
      if (interactive) {
        await msal.loginRedirect({ scopes: [config.scope], prompt: 'select_account' });
        return null;
      }
      const account = msal.getActiveAccount() ?? msal.getAllAccounts()[0];
      if (account) {
        try { return (await msal.acquireTokenSilent({ account, scopes: [config.scope] })).accessToken; }
        catch { return null; }
      }
      return null;
    },
    async logout() { await msal.logoutRedirect({ postLogoutRedirectUri: `${config.origin}/` }); },
  });
} catch {
  document.getElementById('message')!.textContent = '登录初始化失败，请检查管理入口配置或重新打开页面。';
}
