// Handle interactive rating stars and submit customer feedback.
(() => {
  const T = (key, vars) => (window.t ? window.t(key, vars) : key);
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('sessionId') || localStorage.getItem('sessionId');
  const stars = [...document.querySelectorAll('.rating-star')];
  const form = document.getElementById('feedback-form');
  const submitButton = document.getElementById('feedback-submit');
  const spinner = document.getElementById('feedback-spinner');
  const errorElement = document.getElementById('feedback-error');
  const successElement = document.getElementById('feedback-success');
  let rating = 0;

  function renderStars(selectedRating) {
    stars.forEach((star) => {
      const isSelected = Number(star.dataset.rating) <= selectedRating;
      star.classList.toggle('text-amber-400', isSelected);
      star.classList.toggle('text-slate-300', !isSelected);
      star.setAttribute('aria-checked', String(Number(star.dataset.rating) === selectedRating));
    });
  }

  stars.forEach((star) => {
    star.addEventListener('click', () => {
      rating = Number(star.dataset.rating);
      renderStars(rating);
    });
    star.addEventListener('mouseenter', () => renderStars(Number(star.dataset.rating)));
  });
  document.getElementById('rating-stars').addEventListener('mouseleave', () => renderStars(rating));
  document.getElementById('rating-stars').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = Math.max(0, stars.findIndex((star) => Number(star.dataset.rating) === rating));
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? stars.length - 1
        : Math.min(stars.length - 1, Math.max(0, currentIndex + (event.key === 'ArrowRight' ? 1 : -1)));
    stars[nextIndex].focus();
    rating = Number(stars[nextIndex].dataset.rating);
    renderStars(rating);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorElement.classList.add('hidden');
    if (!sessionId) {
      errorElement.textContent = T('feedback.noSession');
      errorElement.classList.remove('hidden');
      return;
    }
    if (rating < 1 || rating > 5) {
      errorElement.textContent = T('feedback.chooseRating');
      errorElement.classList.remove('hidden');
      return;
    }

    submitButton.disabled = true;
    spinner.classList.remove('hidden');
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          rating,
          comment: document.getElementById('feedback-comment').value.trim(),
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error((payload.code && T(`error.${payload.code}`)) || payload.message || T('error.REQUEST_FAILED'));
      }

      form.classList.add('hidden');
      successElement.classList.remove('hidden');
    } catch (error) {
      errorElement.textContent = error.message || T('error.REQUEST_FAILED');
      errorElement.classList.remove('hidden');
      submitButton.disabled = false;
    } finally {
      spinner.classList.add('hidden');
    }
  });

  window.addEventListener('languageChanged', () => {
    if (rating > 0) renderStars(rating);
  });
})();