import "dotenv/config";
import crypto from "crypto";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI, Type } from "@google/genai";
import { calculateFourPillars } from "manseryeok";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
app.use("/images", express.static(path.join(__dirname, "images")));

const PORT = process.env.PORT || 3000;
const MODEL_CANDIDATES = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-4-hydrogen"];
const JWT_SECRET = process.env.JWT_SECRET || "byeolbit_fallback_secret_2026";
const REQUIRE_CREDITS = process.env.REQUIRE_CREDITS !== "false";

const sajuJobs = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of sajuJobs.entries()) {
    if (now - job.createdAt > 15 * 60 * 1000) sajuJobs.delete(id);
  }
}, 5 * 60 * 1000);

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    : null;

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/images/loading.mp4", (req, res) => res.sendFile(path.join(__dirname, "loading.mp4")));
app.get("/images/intro.mp4", (req, res) => res.sendFile(path.join(__dirname, "intro.mp4")));

async function getAuthUser(req) {
  try {
    const token = req.cookies?.byeolbit_token;
    if (!token || !supabase) return null;
    const decoded = jwt.verify(token, JWT_SECRET);
    const { data, error } = await supabase.from("users").select("id, kakao_id, nickname, credits").eq("id", decoded.userId).single();
    return error || !data ? null : data;
  } catch { return null; }
}

function getBaseUrl(req) {
  const rawProto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  return `${String(rawProto).split(",")[0].trim()}://${req.get("host")}`;
}

function setAuthCookie(req, res, user) {
  const token = jwt.sign({ userId: user.id, nickname: user.nickname }, JWT_SECRET, { expiresIn: "30d" });
  const isHttps = req.secure || String(req.headers["x-forwarded-proto"] || "").includes("https");
  res.cookie("byeolbit_token", token, { httpOnly: true, sameSite: "lax", secure: isHttps, maxAge: 1000 * 60 * 60 * 24 * 30 });
}

function sendLoginErrorPage(res, title, detail) {
  res.status(500).send(`<html lang="ko"><body style="background:#0b0c14;color:#fff;font-family:sans-serif;padding:40px;"><h2>⚠️ 카카오 로그인 오류</h2><p style="color:#fde68a;">${title}</p><pre style="background:#181a28;padding:16px;border-radius:12px;color:#fda4af;">${detail}</pre><br/><a href="/" style="color:#93c5fd;">← 돌아가기</a></body></html>`);
}

app.get("/auth/kakao", (req, res) => {
  const clientId = process.env.KAKAO_CLIENT_ID;
  if (!clientId) return sendLoginErrorPage(res, "KAKAO_CLIENT_ID 미설정", "환경변수를 확인하세요.");
  const redirectUri = `${getBaseUrl(req)}/auth/kakao/callback`;
  res.redirect(`https://kauth.kakao.com/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`);
});

app.get("/auth/kakao/callback", async (req, res) => {
  try {
    const { code, error, error_description } = req.query;
    if (error || !code) return sendLoginErrorPage(res, "카카오 인증 취소", `${error}: ${error_description || ""}`);
    if (!supabase) return sendLoginErrorPage(res, "Supabase 미연결", "환경변수 확인 필요");

    const bodyParams = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: process.env.KAKAO_CLIENT_ID,
      redirect_uri: `${getBaseUrl(req)}/auth/kakao/callback`,
      code: String(code),
    });
    if (process.env.KAKAO_CLIENT_SECRET) bodyParams.append("client_secret", process.env.KAKAO_CLIENT_SECRET);

    const tokenData = await (await fetch("https://kauth.kakao.com/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" }, body: bodyParams,
    })).json();
    if (!tokenData.access_token) return sendLoginErrorPage(res, "카카오 토큰 실패", JSON.stringify(tokenData));

    const kakaoUser = await (await fetch("https://kapi.kakao.com/v2/user/me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })).json();
    const kakaoId = String(kakaoUser.id);
    const nickname = kakaoUser.kakao_account?.profile?.nickname || kakaoUser.properties?.nickname || "별빛회원";

    let { data: existingUser, error: selectErr } = await supabase.from("users").select("id, kakao_id, nickname, credits").eq("kakao_id", kakaoId).maybeSingle();
    if (selectErr) return sendLoginErrorPage(res, "DB 조회 실패", JSON.stringify(selectErr));

    if (!existingUser) {
      const { data: created, error: insertErr } = await supabase.from("users").insert({ kakao_id: kakaoId, nickname, credits: 1 }).select("id, kakao_id, nickname, credits").single();
      if (insertErr) return sendLoginErrorPage(res, "DB 저장 실패", JSON.stringify(insertErr));
      existingUser = created;
    } else if (existingUser.nickname !== nickname) {
      await supabase.from("users").update({ nickname }).eq("id", existingUser.id);
      existingUser.nickname = nickname;
    }

    setAuthCookie(req, res, existingUser);
    res.redirect("/");
  } catch (err) {
    return sendLoginErrorPage(res, "서버 오류", err?.message || String(err));
  }
});

app.get("/api/me", async (req, res) => res.json({ user: await getAuthUser(req) }));
app.post("/auth/logout", (req, res) => { res.clearCookie("byeolbit_token"); res.json({ ok: true }); });

let fallbackVisits = Number(process.env.START_VISITS || 78000);
app.post("/api/visit", async (req, res) => {
  try {
    if (supabase) {
      const { data } = await supabase.from("site_stats").select("count").eq("id", "visits").maybeSingle();
      const nextCount = (data?.count ? Number(data.count) : fallbackVisits) + 1;
      await supabase.from("site_stats").upsert({ id: "visits", count: nextCount });
      return res.json({ count: nextCount });
    }
  } catch {}
  fallbackVisits += 1;
  res.json({ count: fallbackVisits });
});

app.get("/api/history", async (req, res) => {
  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ error: "로그인이 필요합니다." });
  const { data, error } = await supabase.from("saju_history").select("id, mode, subject_name, birth_summary, result_json, created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(20);
  if (error) return res.status(500).json({ error: "보관함 조회 실패" });
  res.json({ items: data || [] });
});

app.delete("/api/history/:id", async (req, res) => {
  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ error: "로그인이 필요합니다." });
  await supabase.from("saju_history").delete().eq("id", Number(req.params.id)).eq("user_id", user.id);
  res.json({ ok: true });
});
const STEM_INFO = {
  갑: { hanja: "甲", element: "목", yinYang: "양", title: "큰 소나무(갑목)" },
  을: { hanja: "乙", element: "목", yinYang: "음", title: "유연한 화초(을목)" },
  병: { hanja: "丙", element: "화", yinYang: "양", title: "찬란한 태양(병화)" },
  정: { hanja: "丁", element: "화", yinYang: "음", title: "은은한 촛불(정화)" },
  무: { hanja: "戊", element: "토", yinYang: "양", title: "묵직한 태산(무토)" },
  기: { hanja: "己", element: "토", yinYang: "음", title: "비옥한 대지(기토)" },
  경: { hanja: "庚", element: "금", yinYang: "양", title: "단단한 원석(경금)" },
  신: { hanja: "辛", element: "금", yinYang: "음", title: "빛나는 보석(신금)" },
  임: { hanja: "壬", element: "수", yinYang: "양", title: "깊고 넓은 바다(임수)" },
  계: { hanja: "癸", element: "수", yinYang: "음", title: "촉촉한 봄비(계수)" },
};

const BRANCH_INFO = {
  자: { hanja: "子", element: "수", animal: "쥐" }, 축: { hanja: "丑", element: "토", animal: "소" },
  인: { hanja: "寅", element: "목", animal: "호랑이" }, 묘: { hanja: "卯", element: "목", animal: "토끼" },
  진: { hanja: "辰", element: "토", animal: "용" }, 사: { hanja: "巳", element: "화", animal: "뱀" },
  오: { hanja: "午", element: "화", animal: "말" }, 미: { hanja: "未", element: "토", animal: "양" },
  신: { hanja: "申", element: "금", animal: "원숭이" }, 유: { hanja: "酉", element: "금", animal: "닭" },
  술: { hanja: "戌", element: "토", animal: "개" }, 해: { hanja: "亥", element: "수", animal: "돼지" },
};

function parsePillar(koreanPillar) {
  if (!koreanPillar || typeof koreanPillar !== "string" || koreanPillar.length < 2) return null;
  const stem = koreanPillar[0], branch = koreanPillar[1];
  const sInfo = STEM_INFO[stem] || { hanja: "?", element: "토", yinYang: "양", title: stem };
  const bInfo = BRANCH_INFO[branch] || { hanja: "?", element: "토", animal: "" };
  return { korean: koreanPillar, hanja: `${sInfo.hanja}${bInfo.hanja}`, stem: { korean: stem, ...sInfo }, branch: { korean: branch, ...bInfo } };
}

function calculateElements(pillars, includeHour) {
  const counts = { 목: 0, 화: 0, 토: 0, 금: 0, 수: 0 };
  const active = includeHour ? [pillars.year, pillars.month, pillars.day, pillars.hour] : [pillars.year, pillars.month, pillars.day];
  for (const p of active) {
    if (!p) continue;
    counts[p.stem.element] = (counts[p.stem.element] || 0) + 1;
    counts[p.branch.element] = (counts[p.branch.element] || 0) + 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const distribution = Object.entries(counts).map(([name, count]) => ({ name, count, percent: Math.round((count / total) * 100) }));
  const sorted = [...distribution].sort((a, b) => b.count - a.count);
  return { counts, distribution, dominant: sorted[0].name, lacking: sorted.filter((e) => e.count === 0).map((e) => e.name), weakest: sorted[sorted.length - 1].name };
}

function extractSpecialBadges(pillars, includeHour) {
  const badges = [];
  const list = includeHour ? [pillars.year, pillars.month, pillars.day, pillars.hour] : [pillars.year, pillars.month, pillars.day];
  const stems = list.filter(Boolean).map((p) => p.stem.korean);
  const branches = list.filter(Boolean).map((p) => p.branch.korean);
  const dayStem = pillars.day.stem.korean;

  const gwiinMap = { 갑: ["축", "미"], 무: ["축", "미"], 경: ["축", "미"], 을: ["자", "신"], 기: ["자", "신"], 병: ["해", "유"], 정: ["해", "유"], 신: ["인", "오"], 임: ["사", "묘"], 계: ["사", "묘"] };
  if ((gwiinMap[dayStem] || []).some((b) => branches.includes(b))) badges.push({ type: "good", text: "✨ 천을귀인" });
  for (const [a, b] of [["갑", "기"], ["을", "경"], ["병", "신"], ["정", "임"], ["무", "계"]]) if (stems.includes(a) && stems.includes(b)) badges.push({ type: "hap", text: `💫 ${a}${b} 천간합` });
  for (const [a, b] of [["자", "축"], ["인", "해"], ["묘", "술"], ["진", "유"], ["사", "신"], ["오", "미"]]) if (branches.includes(a) && branches.includes(b)) badges.push({ type: "hap", text: `💛 ${a}${b} 육합` });
  for (const [a, b] of [["자", "오"], ["축", "미"], ["인", "신"], ["묘", "유"], ["진", "술"], ["사", "해"]]) if (branches.includes(a) && branches.includes(b)) badges.push({ type: "chung", text: `⚡ ${a}${b}충` });
  if (branches.some((b) => ["자", "오", "묘", "유"].includes(b))) badges.push({ type: "sinsal", text: "🌸 도화 기운" });
  if (branches.some((b) => ["인", "신", "사", "해"].includes(b))) badges.push({ type: "sinsal", text: "🐎 역마 기운" });
  if (branches.some((b) => ["진", "술", "축", "미"].includes(b))) badges.push({ type: "sinsal", text: "🎨 화개 기운" });
  return badges.slice(0, 6);
}

const LITE_SAJU_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    personaTitle: { type: Type.STRING }, todayScore: { type: Type.INTEGER }, todayKeyword: { type: Type.STRING },
    todayFortune: { type: Type.STRING }, briefSajuSummary: { type: Type.STRING },
    luckyColor: { type: Type.STRING }, luckyNumber: { type: Type.STRING }, oneLineAdvice: { type: Type.STRING },
  },
  required: ["personaTitle", "todayScore", "todayKeyword", "todayFortune", "briefSajuSummary", "luckyColor", "luckyNumber", "oneLineAdvice"],
};

// 4가지 상품 공통 1만자+ 스키마 (전반부 5,500자+)
const PROD_PART1_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    personaTitle: { type: Type.STRING },
    scoreBadge: { type: Type.INTEGER, description: "해당 운세 또는 궁합 핵심 지수 (65~99)" },
    keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
    executiveSummary: { type: Type.STRING, description: "핵심 총평 (최소 1,000자 이상, 줄바꿈 포함)" },
    overviewDeep: { type: Type.STRING, description: "해당 상품(종합사주/대운/궁합/2027신년운세)의 명리학적 정밀 본론 분석 (최소 2,400자 이상, [소제목] 구분)" },
    wealthDeep: { type: Type.STRING, description: "이 상품 관점에서의 재물·주식·부동산·투자·돈의 흐름 정밀 분석 (최소 2,200자 이상, [소제목] 구분)" },
    luckyGuide: {
      type: Type.OBJECT,
      properties: { colorName: { type: Type.STRING }, colorHex: { type: Type.STRING }, numbers: { type: Type.STRING }, direction: { type: Type.STRING }, luckyItem: { type: Type.STRING }, dailyRitual: { type: Type.STRING } },
      required: ["colorName", "colorHex", "numbers", "direction", "luckyItem", "dailyRitual"],
    },
  },
  required: ["personaTitle", "scoreBadge", "keywords", "executiveSummary", "overviewDeep", "wealthDeep", "luckyGuide"],
};

// 4가지 상품 공통 1만자+ 스키마 (후반부 5,500자+)
const PROD_PART2_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    loveDeep: { type: Type.STRING, description: "이 상품 관점에서의 연애·결혼·배우자궁·인연·대인관계 정밀 분석 (최소 2,200자 이상, [소제목] 구분)" },
    careerDeep: { type: Type.STRING, description: "이 상품 관점에서의 직업·커리어·이직·승진·사업·성공 전략 정밀 분석 (최소 2,200자 이상, [소제목] 구분)" },
    answerDeep: { type: Type.STRING, description: "의뢰인의 질문과 해당 상품의 최종 행동 로드맵 및 시기별 주의점 (최소 1,400자 이상, [소제목] 구분)" },
    monthly2027: {
      type: Type.ARRAY,
      description: "2027년 정미년 1~12월 월별 요약 카드 12개",
      items: {
        type: Type.OBJECT,
        properties: { month: { type: Type.INTEGER }, grade: { type: Type.STRING }, keyword: { type: Type.STRING }, tip: { type: Type.STRING } },
        required: ["month", "grade", "keyword", "tip"],
      },
    },
  },
  required: ["loveDeep", "careerDeep", "answerDeep", "monthly2027"],
};

async function callGeminiFast({ apiKey, systemInstruction, prompt, schema, maxTokens }) {
  const ai = new GoogleGenAI({ apiKey });
  const errors = [];
  for (const model of MODEL_CANDIDATES) {
    for (let retry = 0; retry < 2; retry++) {
      try {
        const config = { systemInstruction, temperature: 0.75, maxOutputTokens: maxTokens, httpOptions: { timeout: 60000 } };
        if (schema) { config.responseMimeType = "application/json"; config.responseSchema = schema; }
        const res = await ai.models.generateContent({ model, contents: prompt, config });
        return { text: res.text, model };
      } catch (err) {
        const msg = err?.message || String(err);
        errors.push(`${model}: ${err?.status || msg.slice(0, 60)}`);
        if (msg.includes("404") || msg.includes("NOT_FOUND")) break;
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
  }
  throw new Error(errors.join(" | "));
}

function buildChartObject(input) {
  const sajuRaw = calculateFourPillars({
    year: Number(input.year), month: Number(input.month), day: Number(input.day),
    hour: input.unknownTime ? 12 : Number(input.hour ?? 12), minute: input.unknownTime ? 0 : Number(input.minute ?? 0),
    isLunar: Boolean(input.isLunar), isLeapMonth: Boolean(input.isLunar && input.isLeapMonth),
    gender: input.gender === "male" ? "male" : "female", dayBoundary: input.dayBoundary || "midnight",
    ...(input.useTrueSolarTime !== false && !input.unknownTime ? { trueSolarTime: { longitude: 127.5, applyEquationOfTime: true, applyHistoricalDst: true } } : {}),
  });
  const obj = sajuRaw.toObject();
  const pillars = { year: parsePillar(obj.year), month: parsePillar(obj.month), day: parsePillar(obj.day), hour: input.unknownTime ? null : parsePillar(obj.hour) };
  const elements = calculateElements(pillars, !input.unknownTime);
  const specialBadges = extractSpecialBadges(pillars, !input.unknownTime);
  const luckPillars = (sajuRaw.luckPillars?.pillars || []).slice(0, 8).map((lp) => ({
    age: lp.age, korean: lp.korean || lp.pillar, hanja: parsePillar(lp.korean || lp.pillar)?.hanja || "",
  }));
  return { sajuRaw, chart: { pillars, tenGods: sajuRaw.tenGods || {}, voidBranches: sajuRaw.voidBranches || [], specialBadges, elements, luckPillars: { forward: sajuRaw.luckPillars?.forward ?? true, startAge: sajuRaw.luckPillars?.startAge ?? 1, list: luckPillars } } };
}

const PRODUCT_GUIDES = {
  saju: "【상품 1: 정통 종합 사주】 타고난 사주 원국·격국·용신·희신·지장간·12운성·합충형파해를 근간으로 평생의 종합 기질, 재물·투자 DNA, 연애·배우자궁, 커리어·이직 적성까지 총 1만자 이상 깊이 있게 해부하세요.",
  daewoon: "【상품 2: 10년 대운 정밀 풀이】 인생을 10년 단위로 나누어 초년·현재 대운·다음 대운의 전환점을 집중 분석하고, 현재 대운과 다가올 대운 속에서 재물·투자, 연애·결혼, 커리어·이직의 승부 타이밍을 총 1만자 이상 작성하세요.",
  compat: "【상품 3: 2인 정밀 궁합】 두 사람의 일간·일지·오행 상생상극·겉궁합/속궁합을 비교하여, 두 사람이 함께할 때의 종합 인연, 재물·투자 합(돈 복), 연애·갈등 해결, 커리어·일적 시너지까지 총 1만자 이상 작성하세요.",
  newyear: "【상품 4: 2027년 정미년 신년운세】 다가올 2027년 정미년(丁未年)의 세운과 본인 사주의 합충을 중심으로 2027년 한 해 총운, 재물·투자, 연애·인연, 커리어·이직 전략과 1~12월 월별 흐름을 총 1만자 이상 상세히 작성하세요.",
};

app.post("/api/saju", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey.includes("your_gemini")) return res.status(500).json({ error: "GEMINI_API_KEY를 설정해주세요." });

    const authUser = await getAuthUser(req);
    const body = req.body;
    const isLite = body.mode === "lite";
    const productType = isLite ? "lite" : (["saju", "daewoon", "compat", "newyear"].includes(body.productType) ? body.productType : "saju");

    if (!isLite && !authUser) return res.status(401).json({ error: "이 프리미엄 풀이는 카카오 로그인 후 이용하실 수 있습니다." });
    if (!isLite && REQUIRE_CREDITS && authUser.credits <= 0) return res.status(402).json({ error: "보유한 이용권(990원)이 부족합니다." });
    if (!body.year || !body.month || !body.day) return res.status(400).json({ error: "생년월일을 입력해주세요." });
    if (productType === "compat" && !body.partner?.year) return res.status(400).json({ error: "상대방 생년월일을 입력해주세요." });

    let builtA, builtB = null;
    try {
      builtA = buildChartObject(body);
      if (productType === "compat") builtB = buildChartObject(body.partner);
    } catch (e) { return res.status(400).json({ error: `날짜 오류: 음력/윤달 여부를 확인해주세요. (${e.message})` }); }

    const { sajuRaw, chart } = builtA;
    const currentYear = new Date().getFullYear();
    const approxKoreanAge = currentYear - Number(body.year) + 1;
    const koreaTodayText = new Date().toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric", weekday: "long" });

    const formatPerson = (label, input, b) => {
      const p = b.chart.pillars, tg = b.chart.tenGods, el = b.chart.elements;
      return `[${label}: ${input.name || "귀하"} / ${input.gender === "male" ? "남" : "여"} / ${input.isLunar ? "음력" : "양력"} ${input.year}.${input.month}.${input.day} ${input.unknownTime ? "시간미상" : `${input.hour}:${input.minute}`}]
- 원국: ${p.year.korean}(${p.year.hanja}) ${p.month.korean}(${p.month.hanja}) ${p.day.korean}(${p.day.hanja}) ${p.hour ? p.hour.korean + "(" + p.hour.hanja + ")" : "시주미상"}
- 일간: ${p.day.stem.title} / 십신: 년(${tg.year?.stem}/${tg.year?.branch}) 월(${tg.month?.stem}/${tg.month?.branch}) 일지(${tg.day?.branch}) 시(${tg.hour?.stem || "-"}/${tg.hour?.branch || "-"})
- 오행: 목${el.counts["목"]} 화${el.counts["화"]} 토${el.counts["토"]} 금${el.counts["금"]} 수${el.counts["수"]} (강:${el.dominant}, 약:${el.lacking.join(",") || el.weakest})
- 특수/공망: ${b.chart.specialBadges.map((x) => x.text).join(",")} | 공망:${b.chart.voidBranches.join(",")}
- 지장간:${JSON.stringify(b.sajuRaw.hiddenStems)} | 12운성:${JSON.stringify(b.sajuRaw.twelveStages)} | 합충:${JSON.stringify(b.sajuRaw.relations)}
- 대운(${b.chart.luckPillars.forward ? "순행" : "역행"}, 대운수${b.chart.luckPillars.startAge}): ${b.chart.luckPillars.list.map((l) => `${l.age}세(${l.korean})`).join("→")}`;
    };

    const fullDataText = `${formatPerson("본인", body, builtA)}
${builtB ? `\n[관계: ${body.relationType || "연인·결혼"}]\n${formatPerson("상대방", body.partner, builtB)}` : ""}
[오늘 날짜] ${koreaTodayText} (본인 한국나이 약 ${approxKoreanAge}세)
[질문] ${(body.customQuestion || "").trim() || "전체 영역을 상세히 알고 싶습니다."}`;

    const jobId = crypto.randomUUID();
    sajuJobs.set(jobId, { status: "processing", createdAt: Date.now() });

    (async () => {
      try {
        let reading, usedModel;
        if (isLite) {
          const r = await callGeminiFast({
            apiKey, systemInstruction: `당신은 '별빛운세정원'입니다. 오늘(${koreaTodayText})의 운세와 간단 사주 요약을 작성하세요.`,
            prompt: `${formatPerson("본인", body, builtA)}\n\n오늘의 운세 JSON 작성.`, schema: LITE_SAJU_SCHEMA, maxTokens: 2048,
          });
          reading = JSON.parse(String(r.text || "{}").replace(/^```json\s*/i, "").replace(/```$/g, "").trim());
          usedModel = r.model;
        } else {
          const sys = `당신은 한국 최고 명리학 대가 '별빛운세정원'입니다. ${PRODUCT_GUIDES[productType]}
반드시 전체 텍스트 합이 공백 포함 **한국어 10,000자 이상**이 되도록 각 항목 최소 분량을 꽉 채워 쓰고, [소제목]과 줄바꿈(\\n\\n)으로 작성하세요.`;

          const p1 = await callGeminiFast({
            apiKey, systemInstruction: sys,
            prompt: `${fullDataText}\n\n[전반부: 핵심 총평 + 본론 정밀 분석 + 재물/투자운 + 개운 처방] JSON(최소 5,500자 이상)을 작성해주세요.`,
            schema: PROD_PART1_SCHEMA, maxTokens: 12288,
          });
          await new Promise((r) => setTimeout(r, 700));
          const p2 = await callGeminiFast({
            apiKey, systemInstruction: sys,
            prompt: `${fullDataText}\n\n[후반부: 연애/인연운 + 커리어/이직운 + 최종 해답/로드맵 + 2027년 12개월 월별 카드] JSON(최소 5,500자 이상)을 작성해주세요.`,
            schema: PROD_PART2_SCHEMA, maxTokens: 12288,
          });
          const part1 = JSON.parse(String(p1.text || "{}").replace(/^```json\s*/i, "").replace(/```$/g, "").trim());
          const part2 = JSON.parse(String(p2.text || "{}").replace(/^```json\s*/i, "").replace(/```$/g, "").trim());
          reading = { ...part1, ...part2 };
          usedModel = p1.model;
        }

        const totalChars = isLite
          ? (reading.todayFortune?.length || 0) + (reading.briefSajuSummary?.length || 0)
          : [reading.executiveSummary, reading.overviewDeep, reading.wealthDeep, reading.loveDeep, reading.careerDeep, reading.answerDeep].filter(Boolean).join("").length;

        const birthText = `${body.year}.${String(body.month).padStart(2, "0")}.${String(body.day).padStart(2, "0")} ${body.unknownTime ? "시간 미상" : `${String(body.hour).padStart(2, "0")}:${String(body.minute).padStart(2, "0")}`}`;
        const resultPayload = {
          mode: isLite ? "lite" : "full",
          productType,
          meta: {
            name: body.name || "귀하", partnerName: body.partner?.name || "", relationType: body.relationType || "",
            gender: body.gender || "female", solarOrLunar: body.isLunar ? (body.isLeapMonth ? "음력(윤달)" : "음력") : "양력",
            birthText, todayText: koreaTodayText, approxKoreanAge, model: usedModel, totalChars,
          },
          chart, partnerChart: builtB?.chart || null, reading,
        };

        if (authUser && supabase) {
          const titleMap = { lite: "오늘의 운세", saju: "정통 종합사주", daewoon: "10년 대운", compat: `궁합(${body.partner?.name || "상대"})`, newyear: "2027 신년운세" };
          await supabase.from("saju_history").insert({
            user_id: authUser.id, mode: productType, subject_name: `${body.name || "귀하"} · ${titleMap[productType]}`,
            birth_summary: `${resultPayload.meta.solarOrLunar} ${birthText}`, result_json: resultPayload,
          });
          if (!isLite && REQUIRE_CREDITS) await supabase.from("users").update({ credits: authUser.credits - 1 }).eq("id", authUser.id);
        }
        sajuJobs.set(jobId, { status: "done", result: resultPayload, createdAt: Date.now() });
      } catch (bgErr) {
        sajuJobs.set(jobId, { status: "error", error: `AI 분석 오류: ${bgErr?.message}`, createdAt: Date.now() });
      }
    })();

    res.json({ jobId });
  } catch (err) {
    res.status(500).json({ error: `오류: ${err?.message}` });
  }
});

app.post("/api/saju/followup", async (req, res) => {
  try {
    const { contextSummary, question } = req.body;
    if (!question?.trim()) return res.status(400).json({ error: "질문을 입력해주세요." });
    const aiRes = await callGeminiFast({
      apiKey: process.env.GEMINI_API_KEY,
      systemInstruction: "당신은 사주 상담가 '별빛운세정원'입니다. 아래 사주 정보를 바탕으로 추가 질문에 4~6문장으로 명쾌하게 답해주세요.",
      prompt: `[사주 요약]\n${contextSummary}\n\n[질문]\n${question}`, schema: null, maxTokens: 1024,
    });
    res.json({ answer: aiRes.text });
  } catch { res.status(500).json({ error: "잠시 후 다시 눌러주세요." }); }
});

app.get("/api/saju/status/:jobId", (req, res) => {
  const job = sajuJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: "error", error: "작업 시간이 초과되었습니다." });
  if (job.status === "done") { sajuJobs.delete(req.params.jobId); return res.json({ status: "done", data: job.result }); }
  if (job.status === "error") { sajuJobs.delete(req.params.jobId); return res.json({ status: "error", error: job.error }); }
  res.json({ status: "processing" });
});
function checkAdmin(req, res) {
  const pin = req.headers["x-admin-pin"] || req.query.pin || req.body?.adminPin;
  const validPin = process.env.ADMIN_PIN || "9900";
  if (String(pin) !== String(validPin)) {
    res.status(403).json({ error: "관리자 PIN이 올바르지 않습니다." });
    return false;
  }
  return true;
}

app.get("/api/admin/dashboard", async (req, res) => {
  if (!checkAdmin(req, res)) return;
  if (!supabase) return res.status(500).json({ error: "DB 미연결" });
  const [{ data: users }, { data: history }, { data: stats }] = await Promise.all([
    supabase.from("users").select("id, kakao_id, nickname, credits, created_at").order("created_at", { ascending: false }).limit(100),
    supabase.from("saju_history").select("id, user_id, mode, subject_name, birth_summary, created_at").order("created_at", { ascending: false }).limit(50),
    supabase.from("site_stats").select("count").eq("id", "visits").maybeSingle(),
  ]);
  res.json({ visits: stats?.count || fallbackVisits, users: users || [], history: history || [] });
});

app.post("/api/admin/users/:id/credits", async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const userId = Number(req.params.id);
  const delta = Number(req.body.delta || 0);
  const { data: u } = await supabase.from("users").select("credits").eq("id", userId).single();
  if (!u) return res.status(404).json({ error: "회원을 찾을 수 없습니다." });
  const nextCredits = Math.max(0, Number(u.credits || 0) + delta);
  await supabase.from("users").update({ credits: nextCredits }).eq("id", userId);
  res.json({ credits: nextCredits });
});
app.listen(PORT, "0.0.0.0", () => console.log(`✨ 별빛운세정원 서버 실행: http://0.0.0.0:${PORT}`));
app.post("/api/charge/test", async (req, res) => {
  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ error: "카카오 로그인 후 이용해 주세요." });
  const { amount, adminPin } = req.body;
  const validPin = process.env.ADMIN_PIN || "9900";
  if (String(adminPin) !== String(validPin)) {
    return res.status(403).json({ error: "현재 정식 카드결제(PG) 연동 준비 중입니다. (관리자 PIN이 일치하지 않습니다.)" });
  }
  const add = [1, 5, 10].includes(Number(amount)) ? Number(amount) : 1;
  const nextCredits = Number(user.credits || 0) + add;
  await supabase.from("users").update({ credits: nextCredits }).eq("id", user.id);
  res.json({ credits: nextCredits });
});
