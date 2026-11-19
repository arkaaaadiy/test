const http = require('node:http');
const https = require('node:https');
const { performance } = require('node:perf_hooks');
const { parseArgs } = require('node:util');

const REQUEST_COUNT = 10;
const IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_SECONDS = 120;
// Таймеры Node.js принимают задержку до 2^31 − 1 миллисекунд.
const MAX_TIMEOUT_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

function downloadOnce(url, timeoutSeconds) {
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.get(url, { agent: false }, (response) => {
      const status = response.statusCode;
      if (status < 200 || status >= 300) {
        const reason = status >= 300 && status < 400
          ? 'Укажите конечный URL файла.'
          : response.statusMessage;
        response.destroy();
        reject(new Error(`HTTP ${status}. ${reason}`));
        return;
      }

      let bytes = 0;
      response.on('data', (chunk) => { bytes += chunk.length; });
      response.on('error', reject);
      response.on('end', () => resolve(bytes));
    });

    const deadline = setTimeout(() => {
      request.destroy(new Error(`Превышено полное время запроса (${timeoutSeconds} с).`));
    }, timeoutSeconds * 1000);
    request.once('close', () => clearTimeout(deadline));
    request.on('error', reject);
    request.setTimeout(IDLE_TIMEOUT_MS, () => {
      request.destroy(new Error('Нет данных от сервера в течение 30 секунд.'));
    });
  });
}

async function main(args) {
  const usage = 'Запуск: node speedtest.js [--timeout СЕКУНДЫ] "https://example.org/file.jpg"';
  let options;
  try {
    options = parseArgs({
      args,
      allowPositionals: true,
      options: { timeout: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (error) {
    console.error(error.message + '\n' + usage);
    process.exitCode = 2;
    return;
  }
  const { values, positionals } = options;
  if (values.help) {
    console.log(usage);
    console.log(`--timeout задаёт лимит одного запроса в секундах (по умолчанию ${DEFAULT_TIMEOUT_SECONDS}).`);
    return;
  }

  const timeoutSeconds = Number(values.timeout ?? DEFAULT_TIMEOUT_SECONDS);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    console.error(`--timeout должен быть целым числом секунд от 1 до ${MAX_TIMEOUT_SECONDS}.`);
    process.exitCode = 2;
    return;
  }

  const url = positionals.length === 1 && URL.canParse(positionals[0]) ? new URL(positionals[0]) : null;
  if (!url || !['http:', 'https:'].includes(url.protocol)) {
    console.error('Передайте один HTTP- или HTTPS-адрес файла.\n' + usage);
    process.exitCode = 2;
    return;
  }

  let totalBytes = 0;
  let totalMs = 0;
  for (let number = 1; number <= REQUEST_COUNT; number++) {
    try {
      const start = performance.now();
      totalBytes += await downloadOnce(url, timeoutSeconds);
      totalMs += performance.now() - start;
    } catch (error) {
      console.error(`Запрос ${number}/${REQUEST_COUNT} прерван. ${error.message}`);
      process.exitCode = 1;
      return;
    }
  }

  const totalSeconds = totalMs / 1000;
  console.log(`Выполнено запросов: ${REQUEST_COUNT}`);
  console.log(`Среднее время запроса: ${(totalSeconds / REQUEST_COUNT).toFixed(3)} с`);
  console.log(`Всего скачано: ${totalBytes} байт`);
  if (totalBytes === 0) {
    console.error('Получено 0 байт. Измерить скорость не удалось.');
    process.exitCode = 1;
    return;
  }
  const megabitsPerSecond = (totalBytes * 8) / totalSeconds / 1_000_000;
  console.log(`Скорость скачивания: ${megabitsPerSecond.toFixed(3)} Мбит/с`);
}

main(process.argv.slice(2));
