// 대현고 복도 모니터용 동적 RSS
// 오늘의 중식(나이스) + 현재 날씨·시간별 예보(기상청) + 미세먼지(에어코리아)
//
// Vercel 환경변수 (Settings → Environment Variables)
//   DATA_GO_KR_KEY : 공공데이터포털 인증키 (Decoding 키 권장, Encoding 키도 동작)  ← 필수
//   NEIS_KEY       : 나이스 교육정보 개방 포털 인증키 (없어도 동작하지만 넣는 것을 권장)
//   WEATHER_NX, WEATHER_NY : 기상청 격자 좌표 (기본 102, 83 = 울산 남구 야음동 일대)
//   AIR_STATIONS   : 미세먼지 측정소 우선순위, 쉼표로 구분 (기본 "야음동,신정동,부곡동,여천동")
//
// 확인용: /api/rss?debug=1  → 각 데이터의 원본 요약과 울산 측정소 목록을 JSON으로 보여줌

const SCHOOL = { atpt: 'H10', code: '7480093', name: '대현고등학교' }; // 울산광역시교육청 / 대현고
const DEFAULT_GRID = { nx: 102, ny: 83 };
const DEFAULT_STATIONS = '야음동,신정동,부곡동,여천동';
const FORECAST_HOURS = 6; // 시간별 예보로 보여줄 시간 수

// ---------- 공통 ----------
const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];

// Vercel 서버는 UTC로 동작하므로 한국 시간(UTC+9)을 직접 계산
function kstParts(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), min: d.getUTCMinutes(), dow: d.getUTCDay(),
  };
}
const ymd = (p) => `${p.y}${pad(p.m)}${pad(p.d)}`;

function serviceKey() {
  let k = (process.env.DATA_GO_KR_KEY || '').trim();
  if (k.includes('%')) { try { k = decodeURIComponent(k); } catch (e) { /* 그대로 사용 */ } }
  return k;
}

async function getJson(url, label) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    try { return JSON.parse(text); }
    catch (e) { throw new Error(`${label} 응답이 JSON이 아님: ${text.slice(0, 150)}`); }
  } finally {
    clearTimeout(timer);
  }
}

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- 1. 급식 (나이스) ----------
function cleanMenu(raw) {
  return raw
    .split(/<br\s*\/?>/i)
    .map((s) => s
      .replace(/\([\d.\s]*\)/g, '')   // 알레르기 번호 (1.2.5.6)
      .replace(/[\d.]+$/g, '')        // 괄호 없이 끝에 붙은 번호
      .replace(/[*#@&]/g, '')         // 표시용 기호
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean);
}

async function getLunch(now) {
  const p = new URLSearchParams({
    Type: 'json', pIndex: '1', pSize: '10',
    ATPT_OFCDC_SC_CODE: SCHOOL.atpt, SD_SCHUL_CODE: SCHOOL.code,
    MLSV_YMD: ymd(now), MMEAL_SC_CODE: '2',
  });
  if (process.env.NEIS_KEY) p.set('KEY', process.env.NEIS_KEY.trim());
  const j = await getJson(`https://open.neis.go.kr/hub/mealServiceDietInfo?${p}`, '나이스 급식');
  const rows = j.mealServiceDietInfo && j.mealServiceDietInfo[1] && j.mealServiceDietInfo[1].row;
  if (!rows || !rows.length) return null; // 급식 없는 날 (주말·방학·재량휴업)
  return cleanMenu(rows[0].DDISH_NM);
}

// ---------- 2. 날씨 (기상청 단기예보) ----------
const SKY = { 1: '맑음', 3: '구름많음', 4: '흐림' };
const PTY = { 1: '비', 2: '비/눈', 3: '눈', 4: '소나기', 5: '빗방울', 6: '빗방울·눈날림', 7: '눈날림' };

function grid() {
  return {
    nx: Number(process.env.WEATHER_NX) || DEFAULT_GRID.nx,
    ny: Number(process.env.WEATHER_NY) || DEFAULT_GRID.ny,
  };
}

// 단기예보 발표: 02·05·08·11·14·17·20·23시, 발표 10분 뒤부터 조회 가능
function vilageBase(nowMs) {
  const p = kstParts(nowMs);
  const bases = [23, 20, 17, 14, 11, 8, 5, 2];
  for (const b of bases) {
    if (p.h > b || (p.h === b && p.min >= 15)) return { date: ymd(p), time: `${pad(b)}00` };
  }
  return { date: ymd(kstParts(nowMs - 24 * 3600 * 1000)), time: '2300' };
}

// 초단기실황: 매시 정각 자료, 40분쯤부터 조회 가능
function ncstBase(nowMs) {
  const p = kstParts(nowMs);
  const q = p.min >= 45 ? p : kstParts(nowMs - 3600 * 1000);
  return { date: ymd(q), time: `${pad(q.h)}00` };
}

async function kmaCall(op, base, numOfRows) {
  const { nx, ny } = grid();
  const p = new URLSearchParams({
    serviceKey: serviceKey(), pageNo: '1', numOfRows: String(numOfRows), dataType: 'JSON',
    base_date: base.date, base_time: base.time, nx: String(nx), ny: String(ny),
  });
  const j = await getJson(`https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/${op}?${p}`, `기상청 ${op}`);
  const head = j.response && j.response.header;
  if (!head || head.resultCode !== '00') throw new Error(`기상청 ${op} 오류: ${head ? head.resultMsg : '응답 없음'}`);
  return j.response.body.items.item;
}

async function getWeather(nowMs) {
  const now = kstParts(nowMs);
  const [fcst, ncst] = await Promise.all([
    kmaCall('getVilageFcst', vilageBase(nowMs), 1000),
    kmaCall('getUltraSrtNcst', ncstBase(nowMs), 20).catch(() => []),
  ]);

  // 예보를 시각별로 묶기: { '202610051100': { TMP, SKY, PTY, POP } }
  const byTime = {};
  let tmx = null;
  for (const it of fcst) {
    const key = it.fcstDate + it.fcstTime;
    (byTime[key] = byTime[key] || {})[it.category] = it.fcstValue;
    if (it.category === 'TMX' && it.fcstDate === ymd(now)) tmx = parseFloat(it.fcstValue);
  }
  const desc = (f) => (f.PTY && f.PTY !== '0' ? PTY[f.PTY] : SKY[f.SKY]) || '';

  // 현재: 실황 기온 + 이번 시각 예보의 하늘상태
  const cur = byTime[`${ymd(now)}${pad(now.h)}00`] || {};
  const n = {};
  for (const it of ncst) n[it.category] = it.obsrValue;
  const curTemp = n.T1H !== undefined ? parseFloat(n.T1H) : (cur.TMP !== undefined ? parseFloat(cur.TMP) : null);
  const curDesc = n.PTY && n.PTY !== '0' ? PTY[n.PTY] : desc(cur);

  // 오늘 최고기온: TMX가 없으면 오늘 남은 시간 예보 중 최댓값
  if (tmx === null) {
    const temps = Object.keys(byTime).filter((k) => k.startsWith(ymd(now)) && byTime[k].TMP)
      .map((k) => parseFloat(byTime[k].TMP));
    if (temps.length) tmx = Math.max(...temps);
  }

  // 다음 몇 시간
  const hourly = [];
  for (let i = 1; i <= FORECAST_HOURS; i++) {
    const t = kstParts(nowMs + i * 3600 * 1000);
    const f = byTime[`${ymd(t)}${pad(t.h)}00`];
    if (!f || f.TMP === undefined) continue;
    let s = `${t.h}시 ${Math.round(parseFloat(f.TMP))}℃ ${desc(f)}`;
    if (f.POP && Number(f.POP) >= 30) s += `(강수 ${f.POP}%)`;
    hourly.push(s);
  }
  return { curTemp, curDesc, tmx, hourly };
}

// ---------- 3. 미세먼지 (에어코리아 시도별 실시간) ----------
function grade(value, type) {
  const v = Number(value);
  if (!isFinite(v)) return null;
  const cut = type === 'pm10' ? [30, 80, 150] : [15, 35, 75];
  return v <= cut[0] ? '좋음' : v <= cut[1] ? '보통' : v <= cut[2] ? '나쁨' : '매우나쁨';
}

async function getAir() {
  const p = new URLSearchParams({
    serviceKey: serviceKey(), returnType: 'json', numOfRows: '100', pageNo: '1',
    sidoName: '울산', ver: '1.3',
  });
  const j = await getJson(`https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getCtprvnRltmMesureDnsty?${p}`, '에어코리아');
  const head = j.response && j.response.header;
  if (!head || head.resultCode !== '00') throw new Error(`에어코리아 오류: ${head ? head.resultMsg : '응답 없음'}`);
  const items = j.response.body.items || [];
  const valid = (it) => isFinite(Number(it.pm10Value)) || isFinite(Number(it.pm25Value));
  const prefs = (process.env.AIR_STATIONS || DEFAULT_STATIONS).split(',').map((s) => s.trim()).filter(Boolean);
  let pick = null;
  for (const name of prefs) {
    pick = items.find((it) => it.stationName === name && valid(it));
    if (pick) break;
  }
  if (!pick) pick = items.find(valid) || null;
  return { pick, stations: items.map((it) => it.stationName) };
}

// ---------- RSS 조립 ----------
module.exports = async (req, res) => {
  const nowMs = Date.now();
  const now = kstParts(nowMs);
  const debug = req.query && req.query.debug;
  const errors = [];

  const [lunch, weather, air] = await Promise.all([
    getLunch(now).catch((e) => { errors.push(e.message); return undefined; }),
    getWeather(nowMs).catch((e) => { errors.push(e.message); return undefined; }),
    getAir().catch((e) => { errors.push(e.message); return undefined; }),
  ]);

  const titles = [];
  const dateLabel = `${now.m}월 ${now.d}일(${DAYS[now.dow]})`;

  // 급식
  if (lunch === null) titles.push(`${dateLabel} 오늘은 중식이 없습니다`);
  else if (lunch) titles.push(`${dateLabel} 오늘의 중식: ${lunch.join(' · ')}`);

  // 날씨
  if (weather) {
    let s = '현재 날씨';
    if (weather.curTemp !== null) s += ` ${weather.curTemp.toFixed(1)}℃`;
    if (weather.curDesc) s += ` ${weather.curDesc}`;
    if (weather.tmx !== null) s += ` (오늘 최고 ${Math.round(weather.tmx)}℃)`;
    titles.push(s);
    if (weather.hourly.length) titles.push(`시간별 예보: ${weather.hourly.join(' · ')}`);
  }

  // 미세먼지
  if (air && air.pick) {
    const a = air.pick;
    const hour = (a.dataTime || '').slice(11, 13);
    const parts = [];
    const g10 = grade(a.pm10Value, 'pm10');
    const g25 = grade(a.pm25Value, 'pm25');
    if (g10) parts.push(`미세먼지 ${g10}(${a.pm10Value}㎍/㎥)`);
    if (g25) parts.push(`초미세먼지 ${g25}(${a.pm25Value}㎍/㎥)`);
    if (parts.length) titles.push(`${parts.join(' · ')} - ${a.stationName}${hour ? ` ${Number(hour)}시` : ''} 측정`);
  }

  if (!titles.length) titles.push('정보를 불러오는 중입니다');

  if (debug) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(JSON.stringify({
      kst: `${ymd(now)} ${pad(now.h)}:${pad(now.min)}`,
      grid: grid(), vilageBase: vilageBase(nowMs), ncstBase: ncstBase(nowMs),
      titles, errors, lunch, weather,
      airPicked: air && air.pick, ulsanStations: air && air.stations,
      keys: { DATA_GO_KR_KEY: !!process.env.DATA_GO_KR_KEY, NEIS_KEY: !!process.env.NEIS_KEY },
    }, null, 2));
    return;
  }

  // 오래된 단말기 호환: 특수 단위 기호를 일반 글자로 바꿈
  const plain = (t) => t.replace(/℃/g, '도').replace(/㎍\/㎥/g, '');
  const items = titles.map(plain).map((t) => `    <item>\n      <title>${esc(t)}</title>\n      <description>${esc(t)}</description>\n    </item>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${SCHOOL.name} 복도 모니터</title>
    <link>https://${req.headers.host || ''}/</link>
    <description>오늘의 중식 · 날씨 · 미세먼지</description>
    <language>ko</language>
${items}
  </channel>
</rss>
`;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  // Vercel이 10분간 결과를 저장해 두고 재사용 → 공공 API 호출 횟수 절약
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
  const body = Buffer.from(xml, 'utf8');
  res.setHeader('Content-Length', String(body.length));
  res.status(200).send(body);
};
