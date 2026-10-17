(() => {
  fetch('/api/settings/public').then((response) => response.ok ? response.json() : null).then((payload) => {
    const data = payload && payload.data;
    if (!data) return;
    document.querySelectorAll('[data-shop-name]').forEach((element) => { element.textContent = data.restaurantName; });
    document.querySelectorAll('[data-shop-logo]').forEach((image) => { image.src = data.logoUrl || '/assets/images/logo.png'; });
    document.querySelectorAll('[data-shop-welcome]').forEach((message) => {
      if (data.welcomeMessage) message.textContent = data.welcomeMessage;
    });
    document.querySelectorAll('[data-shop-hero]').forEach((hero) => {
      if (data.heroImageUrl) { hero.src = data.heroImageUrl; hero.classList.remove('hidden'); }
    });
    document.querySelectorAll('[data-shop-phone]').forEach((element) => { element.textContent = data.phone || ''; });
    document.querySelectorAll('[data-shop-address]').forEach((element) => { element.textContent = data.address || ''; });
    document.querySelectorAll('[data-shop-contact]').forEach((contact) => {
      contact.classList.toggle('hidden', !data.phone && !data.address);
      const separator = contact.querySelector('[data-shop-contact-separator]');
      if (separator) separator.classList.toggle('hidden', !data.phone || !data.address);
    });
  }).catch(() => {});
})();
