// Countdown timer shared by the customer menu page.
(() => {
  const T = (key, vars) => (window.t ? window.t(key, vars) : key);
  let timerInterval = null;
  let warnedAtFifteen = false;
  let warnedAtFive = false;
  let notificationReady = false;

  function armNotifications() {
    if (notificationReady) return;
    notificationReady = true;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted' || Notification.permission === 'denied') return;
    Notification.requestPermission().catch(() => {});
  }

  window.addEventListener('pointerdown', armNotifications, { once: true });
  window.addEventListener('keydown', armNotifications, { once: true });

  function notify(title, body) {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    try {
      const n = new Notification(title, { body, icon: '/assets/images/logo.png', tag: 'session-timer' });
      n.onclick = () => { window.focus(); n.close(); };
    } catch (error) {
      console.warn('System notification failed:', error);
    }
  }

  function startTimer(endTime, onTick) {
    if (timerInterval) window.clearInterval(timerInterval);
    warnedAtFifteen = false;
    warnedAtFive = false;
    const endTimestamp = new Date(endTime).getTime();
    const display = document.getElementById('timer-display');
    const container = document.getElementById('session-timer');

    if (!Number.isFinite(endTimestamp) || !display || !container) {
      throw new Error('Session end time is invalid or timer elements are missing.');
    }

    function update() {
      const secondsLeft = Math.max(0, Math.ceil((endTimestamp - Date.now()) / 1000));
      const remaining = {
        hours: Math.floor(secondsLeft / 3600),
        minutes: Math.floor((secondsLeft % 3600) / 60),
        seconds: secondsLeft % 60,
        isExpired: secondsLeft === 0,
      };
      const pad = (value) => String(value).padStart(2, '0');
      display.textContent = `${pad(remaining.hours)}:${pad(remaining.minutes)}:${pad(remaining.seconds)}`;
      container.classList.remove('bg-green-50', 'text-green-800', 'bg-yellow-100', 'text-yellow-900', 'bg-orange-100', 'text-orange-900', 'bg-red-100', 'text-red-800');

      if (remaining.isExpired) {
        container.classList.add('bg-red-100', 'text-red-800');
        display.textContent = T('notification.expired');
        notify(T('notification.expired'), T('notification.expiredBody'));
        if (timerInterval) window.clearInterval(timerInterval);
        timerInterval = null;
      } else if (secondsLeft <= 5 * 60) {
        container.classList.add('bg-orange-100', 'text-orange-900');
        if (!warnedAtFive) {
          warnedAtFive = true;
          notify(T('notification.time5'), T('notification.time5Body'));
          window.dispatchEvent(new CustomEvent('session-expiring', { detail: remaining }));
        }
      } else if (secondsLeft <= 15 * 60) {
        container.classList.add('bg-yellow-100', 'text-yellow-900');
        if (!warnedAtFifteen) {
          warnedAtFifteen = true;
          notify(T('notification.time15'), T('notification.time15Body'));
          window.dispatchEvent(new CustomEvent('session-expiring', { detail: remaining }));
        }
      } else {
        container.classList.add('bg-green-50', 'text-green-800');
      }

      if (typeof onTick === 'function') onTick(remaining);
    }

    update();
    if (timerInterval) window.clearInterval(timerInterval);
    if (endTimestamp > Date.now()) {
      timerInterval = window.setInterval(update, 1000);
    }
  }

  window.startTimer = startTimer;
  window.notifyCustomer = notify;
})();