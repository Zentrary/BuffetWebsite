// Keep staff login state isolated per browser tab and preserve the requested staff page.
(() => {
  function loginUrl() {
    const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    return `/login.html?next=${encodeURIComponent(next)}`;
  }

  function clearCredentials() {
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('staffUser');
    localStorage.removeItem('token');
    localStorage.removeItem('staffUser');
  }

  window.StaffAuth = { loginUrl, clearCredentials };
})();
