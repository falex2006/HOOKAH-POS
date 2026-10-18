// Local component fixture only. No credentials, storage, API or product state.
const theme = document.querySelector('#reference-theme');
theme.addEventListener('change', () => document.body.classList.toggle('light-theme', theme.value === 'light'));
document.querySelector('#reference-motion').addEventListener('change', (event) => document.body.classList.toggle('ui-motion-reduced', event.target.checked));
document.querySelector('#mixed-box').indeterminate = true;
let starts = 0;
const busy = document.querySelector('#busy-button');
const busyLabel = document.querySelector('#busy-label');
const idleLabel = document.querySelector('#busy-idle-label');
const result = document.querySelector('#busy-result');
busy.addEventListener('click', () => {
  if (busy.disabled || busy.getAttribute('aria-busy') === 'true') return;
  starts += 1;
  busy.disabled = true;
  busy.setAttribute('aria-busy', 'true');
  busy.setAttribute('aria-disabled', 'true');
  busy.querySelector('.ui-spinner').hidden = false;
  idleLabel.setAttribute('aria-hidden', 'true');
  busyLabel.removeAttribute('aria-hidden');
  result.textContent = `Запусков: ${starts}. Проверка выполняется…`;
  setTimeout(() => {
    busy.disabled = false;
    busy.removeAttribute('aria-busy');
    busy.removeAttribute('aria-disabled');
    busy.querySelector('.ui-spinner').hidden = true;
    busyLabel.setAttribute('aria-hidden', 'true');
    idleLabel.removeAttribute('aria-hidden');
    result.textContent = `Запусков: ${starts}. Проверка завершена.`;
  }, 5000);
});
