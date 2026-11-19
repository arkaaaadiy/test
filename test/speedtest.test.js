const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const script = path.join(__dirname, '..', 'speedtest.js');

function runCli(...args) {
  return exec(process.execPath, [script, ...args], { timeout: 10_000 });
}

async function startServer(t, handleRequest) {
  const server = http.createServer(handleRequest);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('следующий GET начинается после последнего байта, таймер запускается заново на каждый запрос', async (t) => {
  const events = [];
  let requests = 0;
  const url = await startServer(t, (req, res) => {
    const number = ++requests;
    events.push(`${req.method} ${number}`);
    res.writeHead(200, { 'Content-Length': 4 });
    res.write('abc');
    // Каждая загрузка укладывается в секунду, а все десять вместе занимают больше.
    setTimeout(() => {
      events.push(`конец ${number}`);
      res.end('d');
    }, 150);
  });

  const { stdout } = await runCli('--timeout', '1', url);
  const expected = [];
  for (let i = 1; i <= 10; i++) expected.push(`GET ${i}`, `конец ${i}`);
  assert.deepEqual(events, expected);
  assert.match(stdout, /Выполнено запросов: 10/);
  assert.match(stdout, /Всего скачано: 40 байт/);
});

test('общий лимит прерывает даже непрерывно поступающий ответ', async (t) => {
  let chunks = 0;
  let requests = 0;
  const url = await startServer(t, (req, res) => {
    requests++;
    res.write('x');
    const interval = setInterval(() => {
      chunks++;
      res.write('x');
    }, 25);
    res.once('close', () => clearInterval(interval));
  });

  await assert.rejects(runCli(url, '--timeout', '1'), {
    code: 1,
    stderr: /Запрос 1\/10 прерван\. Превышено полное время запроса \(1 с\)/,
    stdout: '',
  });
  assert.equal(requests, 1);
  assert.ok(chunks >= 2);
});

test('десять ответов без данных дают понятное сообщение и код 1', async (t) => {
  let requests = 0;
  const url = await startServer(t, (req, res) => {
    requests++;
    res.writeHead(204).end();
  });

  await assert.rejects(runCli(url), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /Всего скачано: 0 байт/);
    assert.match(error.stderr, /Измерить скорость не удалось/);
    assert.doesNotMatch(error.stdout, /Мбит\/с/);
    return true;
  });
  assert.equal(requests, 10);
});

test('при сочетании пустых и непустых ответов учитываются все десять запросов', async (t) => {
  const data = Buffer.alloc(125_000);
  let requests = 0;
  const url = await startServer(t, (req, res) => {
    requests++;
    res.end(requests % 2 === 0 ? data : undefined);
  });

  const { stdout } = await runCli(url);
  assert.equal(requests, 10);
  assert.match(stdout, /Всего скачано: 625000 байт/);
  const averageSeconds = Number(/Среднее время запроса: ([\d.]+) с/.exec(stdout)[1]);
  const megabitsPerSecond = Number(/Скорость скачивания: ([\d.]+) Мбит\/с/.exec(stdout)[1]);
  assert.ok(megabitsPerSecond > 0);
  // Из 625 000 байт получается 5 Мбит. Учитываем округление вывода до тысячных.
  assert.ok(Math.abs(averageSeconds - 5 / megabitsPerSecond / 10) < 0.00051);
});

test('обрыв тела на четвёртой загрузке завершает серию без итоговой скорости', async (t) => {
  let requests = 0;
  const url = await startServer(t, (req, res) => {
    if (++requests === 4) {
      res.writeHead(200, { 'Content-Length': 10 });
      res.write('abc', () => res.destroy());
      return;
    }
    res.end('complete');
  });

  await assert.rejects(runCli(url), { code: 1, stderr: /Запрос 4\/10 прерван/, stdout: '' });
  assert.equal(requests, 4);
});

test('некорректный лимит отклоняется до отправки запроса', async () => {
  for (const value of ['0', '1.5', 'abc', '2147484']) {
    await assert.rejects(runCli('--timeout', value, 'http://127.0.0.1'), {
      code: 2, stderr: /--timeout должен быть целым числом секунд/, stdout: '',
    });
  }
});
