// Вход с телефона по ПИН-коду.
'use strict';
const form = document.getElementById('login');
const pin = document.getElementById('pin');
const err = document.getElementById('err');
pin.focus();
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  const btn = form.querySelector('button');
  btn.disabled = true;
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: pin.value.trim() }) });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error);
    location.href = '/';
  } catch (ex) {
    err.textContent = ex.message || 'Не получилось войти';
    pin.select();
  } finally {
    btn.disabled = false;
  }
});
