// Authenticate staff and redirect them to the correct work dashboard.
(() => {
  const form = document.getElementById('login-form');
  const button = document.getElementById('login-submit');
  const spinner = document.getElementById('login-spinner');
  const label = document.getElementById('login-label');
  const errorElement = document.getElementById('login-error');
  const T = (key, vars) => (window.t ? window.t(key, vars) : key);
  let isSubmitting = false;
  const roleDestinations = {
    admin: '/admin/dashboard.html',
    manager: '/admin/dashboard.html',
    kitchen: '/kitchen/kitchen.html',
    waiter: '/waiter/waiter.html',
  };
  const allowedDestinations = {
    admin: new Set([
      '/admin/dashboard.html',
      '/admin/manage-queue.html',
      '/admin/manage-tables.html',
      '/admin/manage-menu.html',
      '/admin/manage-members.html',
      '/admin/manage-staff.html',
      '/admin/admin-setting.html',
      '/admin/reports.html',
      '/admin/checkout.html',
    ]),
    manager: new Set([
      '/admin/dashboard.html',
      '/admin/manage-queue.html',
      '/admin/manage-tables.html',
      '/admin/manage-menu.html',
      '/admin/manage-members.html',
      '/admin/reports.html',
      '/admin/checkout.html',
    ]),
    kitchen: new Set(['/kitchen/kitchen.html']),
    waiter: new Set(['/waiter/waiter.html']),
  };

  /**
   * Toggle login submission state while the authentication request is pending.
   * @param {boolean} loading - Whether a login request is in progress.
   */
  function setLoading(loading) {
    isSubmitting = loading;
    button.disabled = loading;
    spinner.classList.toggle('hidden', !loading);
    label.textContent = loading ? T('login.signingIn') : T('login.signIn');
  }

  window.addEventListener('languageChanged', () => {
    label.textContent = isSubmitting ? T('login.signingIn') : T('login.signIn');
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorElement.classList.add('hidden');
    setLoading(true);

    try {
      const formData = new FormData(form);
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: String(formData.get('username')).trim(),
          password: String(formData.get('password')),
        }),
      });
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.toLowerCase().includes('application/json')) {
        await response.text();
        if (response.status === 404) {
          throw new Error(T('login.apiMissing'));
        }
        throw new Error(T('login.invalidResponse', { status: response.status }));
      }

      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error((payload.code && T(`error.${payload.code}`))
          || payload.message || T('error.INVALID_CREDENTIALS'));
      }

      const role = payload.data.user.role;
      const defaultDestination = roleDestinations[role];
      if (!defaultDestination || !payload.data.token) {
        throw new Error(T('login.unauthorizedRole'));
      }

      const requestedDestination = new URLSearchParams(window.location.search).get('next');
      let destination = defaultDestination;
      if (requestedDestination) {
        const requestedUrl = new URL(requestedDestination, window.location.origin);
        if (
          requestedUrl.origin === window.location.origin
          && allowedDestinations[role].has(requestedUrl.pathname)
        ) {
          destination = `${requestedUrl.pathname}${requestedUrl.search}${requestedUrl.hash}`;
        }
      }

      sessionStorage.setItem('token', payload.data.token);
      sessionStorage.setItem('staffUser', JSON.stringify(payload.data.user));
      localStorage.removeItem('token');
      localStorage.removeItem('staffUser');
      window.location.assign(destination);
    } catch (error) {
      errorElement.textContent = error.message || T('common.error');
      errorElement.classList.remove('hidden');
    } finally {
      setLoading(false);
    }
  });
})();
