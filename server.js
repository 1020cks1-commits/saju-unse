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
const REQUIRE_CREDITS = process.env.REQUIRE_CREDITS === "true";

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
  } catch {
    return null;
  }
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
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
      body: bodyParams,
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
      const { data: created, error: insertErr } = await supabase.from("users").insert({ kakao_id: kakaoId, nickname, credits: 3 }).select("id, kakao_id, nickname, credits").single();
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
  자: { hanja: "子", element: "수", animal: "쥐" },
  축: { hanja: "丑", element: "토", animal: "소" },
  인: { hanja: "寅", element: "목", animal: "호랑이" },
  묘: { hanja: "卯", element: "목", animal: "토끼" },
  진: { hanja: "辰", element: "토", animal: "용" },
  사: { hanja: "巳", element: "화", animal: "뱀" },
  오: { hanja: "午", element: "화", animal: "말" },
  미: { hanja: "未", element: "토", animal: "양" },
  신: { hanja: "申", element: "금", animal: "원숭이" },
  유: { hanja: "酉", element: "금", animal: "닭" },
  술: { hanja: "戌", element: "토", animal: "개" },
  해: { hanja: "亥", element: "수", animal: "돼지" },
};

function parsePillar(koreanPillar) {
  if (!koreanPillar || typeof koreanPillar !== "string" || koreanPillar.length < 2) return null;
  const stem = koreanPillar[0];
  const branch = koreanPillar[1];
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

  const stemHap = [["갑", "기"], ["을", "경"], ["병", "신"], ["정", "임"], ["무", "계"]];
  for (const [a, b] of stemHap) if (stems.includes(a) && stems.includes(b)) badges.push({ type: "hap", text: `💫 ${a}${b} 천간합` });

  const branchHap = [["자", "축"], ["인", "해"], ["묘", "술"], ["진", "유"], ["사", "신"], ["오", "미"]];
  for (const [a, b] of branchHap) if (branches.includes(a) && branches.includes(b)) badges.push({ type: "hap", text: `💛 ${a}${b} 육합` });

  const branchChung = [["자", "오"], ["축", "미"], ["인", "신"], ["묘", "유"], ["진", "술"], ["사", "해"]];
  for (const [a, b] of branchChung) if (branches.includes(a) && branches.includes(b)) badges.push({ type: "chung", text: `⚡ ${a}${b}충` });

  if (branches.some((b) => ["자", "오", "묘", "유"].includes(b))) badges.push({ type: "sinsal", text: "🌸 도화 기운" });
  if (branches.some((b) => ["인", "신", "사", "해"].includes(b))) badges.push({ type: "sinsal", text: "🐎 역마 기운" });
  if (branches.some((b) => ["진", "술", "축", "미"].includes(b))) badges.push({ type: "sinsal", text: "🎨 화개(예술) 기운" });

  return badges.slice(0, 6);
}

const LITE_SAJU_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    personaTitle: { type: Type.STRING },
    todayScore: { type: Type.INTEGER },
    todayKeyword: { type: Type.STRING },
    todayFortune: { type: Type.STRING },
    briefSajuSummary: { type: Type.STRING },
    luckyColor: { type: Type.STRING },
    luckyNumber: { type: Type.STRING },
    oneLineAdvice: { type: Type.STRING },
  },
  required: ["personaTitle", "todayScore", "todayKeyword", "todayFortune", "briefSajuSummary", "luckyColor", "luckyNumber", "oneLineAdvice"],
};

const FULL_PART1_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    personaTitle: { type: Type.STRING },
    keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
    executiveSummary: { type: Type.STRING, description: "사주 전체 핵심 총평 (최소 800자 이상)" },
    chartDeepAnalysis: { type: Type.STRING, description: "조후·억부, 신강/신약, 용신·희신·기신, 지장간·12운성·합충형파해, 공망 정밀 해설 (최소 1,700자 이상, [소제목] 구분)" },
    comprehensiveFortune: { type: Type.STRING, description: "타고난 종합운, 초년·중년·말년 흐름, 잠재력과 리스크 요인 (최소 1,600자 이상, [소제목] 구분)" },
    wealthAndInvestment: { type: Type.STRING, description: "재물 그릇, 근로/사업/투자 적합성, 주식·부동산·현금 전략, 손재 방지법 (최소 1,700자 이상, [소제목] 구분)" },
    luckyGuide: {
      type: Type.OBJECT,
      properties: { colorName: { type: Type.STRING }, colorHex: { type: Type.STRING }, numbers: { type: Type.STRING }, direction: { type: Type.STRING }, luckyItem: { type: Type.STRING }, dailyRitual: { type: Type.STRING } },
      required: ["colorName", "colorHex", "numbers", "direction", "luckyItem", "dailyRitual"],
    },
  },
  required: ["personaTitle", "keywords", "executiveSummary", "chartDeepAnalysis", "comprehensiveFortune", "wealthAndInvestment", "luckyGuide"],
};

const FULL_PART2_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    careerAndJobChange: { type: Type.STRING, description: "최적 직업군 Top 5, 조직 vs 사업 적합도, 이직·승진 타이밍, 처세술 (최소 1,700자 이상, [소제목] 구분)" },
    loveAndRelationships: { type: Type.STRING, description: "연애 패턴, 일지(배우자궁)와 결혼운, 최고 궁합 vs 피할 유형, 귀인운 (최소 1,600자 이상, [소제목] 구분)" },
    newYear2027AndDaewoon: { type: Type.STRING, description: "10년 대운, 2026 병오년 마무리, 2027 정미년 상반기·하반기 월별 흐름과 중장기 로드맵 (최소 1,800자 이상, [소제목] 구분)" },
    questionAnswer: { type: Type.STRING, description: "선택한 분야와 직접 남긴 질문에 대한 명리학적 근거 기반 행동 지침 (최소 1,100자 이상, [소제목] 구분)" },
    monthly2027: {
      type: Type.ARRAY,
      description: "2027년 정미년 1월부터 12월까지 12개월 운세 요약 카드 12개",
      items: {
        type: Type.OBJECT,
        properties: { month: { type: Type.INTEGER }, grade: { type: Type.STRING, description: "대길, 길, 평온, 주의 중 하나" }, keyword: { type: Type.STRING }, tip: { type: Type.STRING } },
        required: ["month", "grade", "keyword", "tip"],
      },
    },
  },
  required: ["careerAndJobChange", "loveAndRelationships", "newYear2027AndDaewoon", "questionAnswer", "monthly2027"],
};

const COMPAT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    compatTitle: { type: Type.STRING },
    score: { type: Type.INTEGER },
    keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
    summary: { type: Type.STRING, description: "두 사람의 전체 궁합 총평 (600자 이상)" },
    elementSynergy: { type: Type.STRING, description: "서로 부족한 오행을 채워주는 상생·보완 관계 분석 (1,200자 이상, [소제목] 구분)" },
    deepBondAndChemistry: { type: Type.STRING, description: "일간·일지 합충으로 본 겉궁합/속궁합/가치관/현실 호흡 (1,300자 이상, [소제목] 구분)" },
    conflictAndAdvice: { type: Type.STRING, description: "갈등 패턴과 오래 행복하게 이어가는 비결 + 2027년 흐름 (1,300자 이상, [소제목] 구분)" },
  },
  required: ["compatTitle", "score", "keywords", "summary", "elementSynergy", "deepBondAndChemistry", "conflictAndAdvice"],
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
        return { text: res.text, model, usedTier: "standard-fast" };
      } catch (err) {
        const msg = err?.message || String(err);
        console.warn(`[${model} 시도${retry + 1} 실패]`, msg);
        errors.push(`${model}: ${err?.status || msg.slice(0, 70)}`);
        if (msg.includes("404") || msg.includes("NOT_FOUND")) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  throw new Error(errors.join(" | "));
}

function buildChartObject(input) {
  const sajuRaw = calculateFourPillars({
    year: Number(input.year),
    month: Number(input.month),
    day: Number(input.day),
    hour: input.unknownTime ? 12 : Number(input.hour ?? 12),
    minute: input.unknownTime ? 0 : Number(input.minute ?? 0),
    isLunar: Boolean(input.isLunar),
    isLeapMonth: Boolean(input.isLunar && input.isLeapMonth),
    gender: input.gender === "male" ? "male" : "female",
    dayBoundary: input.dayBoundary || "midnight",
    ...(input.useTrueSolarTime !== false && !input.unknownTime
      ? { trueSolarTime: { longitude: 127.5, applyEquationOfTime: true, applyHistoricalDst: true } }
      : {}),
  });

  const obj = sajuRaw.toObject();
  const pillars = { year: parsePillar(obj.year), month: parsePillar(obj.month), day: parsePillar(obj.day), hour: input.unknownTime ? null : parsePillar(obj.hour) };
  const elements = calculateElements(pillars, !input.unknownTime);
  const specialBadges = extractSpecialBadges(pillars, !input.unknownTime);
  const luckPillars = (sajuRaw.luckPillars?.pillars || []).slice(0, 8).map((lp) => ({
    age: lp.age,
    korean: lp.korean || lp.pillar,
    hanja: parsePillar(lp.korean || lp.pillar)?.hanja || "",
  }));

  return {
    sajuRaw,
    chart: {
      pillars,
      tenGods: sajuRaw.tenGods || {},
      voidBranches: sajuRaw.voidBranches || [],
      specialBadges,
      elements,
      luckPillars: { forward: sajuRaw.luckPillars?.forward ?? true, startAge: sajuRaw.luckPillars?.startAge ?? 1, list: luckPillars },
    },
  };
}

app.post("/api/saju", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey.includes("your_gemini")) return res.status(500).json({ error: "GEMINI_API_KEY를 설정해주세요." });

    const authUser = await getAuthUser(req);
    const body = req.body;
    const isLite = body.mode === "lite";

    if (!isLite && !authUser) return res.status(401).json({ error: "1만자 정밀 사주는 카카오 로그인 후 이용하실 수 있습니다." });
    if (!isLite && REQUIRE_CREDITS && authUser.credits <= 0) return res.status(402).json({ error: "보유한 이용권이 부족합니다." });
    if (!body.year || !body.month || !body.day) return res.status(400).json({ error: "생년월일을 입력해주세요." });

    let built;
    try { built = buildChartObject(body); } catch (e) { return res.status(400).json({ error: `날짜 오류: 음력/윤달 여부를 확인해주세요. (${e.message})` }); }

    const { sajuRaw, chart } = built;
    const { pillars, tenGods, voidBranches, elements, specialBadges, luckPillars } = chart;
    const name = body.name || "귀하";
    const gender = body.gender || "female";
    const currentYear = new Date().getFullYear();
    const approxKoreanAge = currentYear - Number(body.year) + 1;
    const koreaTodayText = new Date().toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric", weekday: "long" });

    const baseDataText = `
[의뢰인] ${name} / ${gender === "male" ? "남성" : "여성"} / 약 ${approxKoreanAge}세 / ${body.isLunar ? (body.isLeapMonth ? "음력(윤달)" : "음력(평달)") : "양력"} ${body.year}.${body.month}.${body.day} ${body.unknownTime ? "(시간미상)" : `${body.hour}:${body.minute}`}
[오늘 날짜] ${koreaTodayText}
[사주 원국]
- 연주: ${pillars.year.korean}(${pillars.year.hanja}) 십신(${tenGods.year?.stem || "-"}/${tenGods.year?.branch || "-"})
- 월주: ${pillars.month.korean}(${pillars.month.hanja}) 십신(${tenGods.month?.stem || "-"}/${tenGods.month?.branch || "-"})
- 일주: ${pillars.day.korean}(${pillars.day.hanja}) 일간=${pillars.day.stem.title} 지지십신(${tenGods.day?.branch || "-"})
- 시주: ${pillars.hour ? `${pillars.hour.korean}(${pillars.hour.hanja}) 십신(${tenGods.hour?.stem || "-"}/${tenGods.hour?.branch || "-"})` : "미상"}
[오행] 목:${elements.counts["목"]} 화:${elements.counts["화"]} 토:${elements.counts["토"]} 금:${elements.counts["금"]} 수:${elements.counts["수"]} (주도:${elements.dominant}, 부족:${elements.lacking.join(",") || elements.weakest})
[특수기운·공망] ${specialBadges.map((b) => b.text).join(", ")} | 공망: ${voidBranches.join(",") || "없음"}`.trim();

    const fullDataText = `${baseDataText}
[지장간] ${JSON.stringify(sajuRaw.hiddenStems || null)}
[12운성] ${JSON.stringify(sajuRaw.twelveStages || null)}
[합충형파해] ${JSON.stringify(sajuRaw.relations || null)}
[대운(${luckPillars.forward ? "순행" : "역행"}, 대운수 ${luckPillars.startAge})] ${luckPillars.list.map((l) => `${l.age}세(${l.korean}/${l.hanja})`).join(" → ")}
[관심분야] ${body.focusTopic || "종합운"} / 질문: ${(body.customQuestion || "").trim() || "전반적인 인생 전략과 2027년 신년운세가 궁금합니다."}`.trim();

    const jobId = crypto.randomUUID();
    sajuJobs.set(jobId, { status: "processing", createdAt: Date.now() });

    (async () => {
      try {
        let reading, usedModel, usedTier;
        if (isLite) {
          const resLite = await callGeminiFast({
            apiKey,
            systemInstruction: `당신은 다정한 사주 상담가 '별빛운세정원'입니다. 오늘(${koreaTodayText})의 운세와 핵심 사주 요약만 작성하세요.`,
            prompt: `${baseDataText}\n\n오늘의 운세와 간단 풀이 JSON을 작성해주세요.`,
            schema: LITE_SAJU_SCHEMA,
            maxTokens: 2048,
          });
          reading = JSON.parse(String(resLite.text || "{}").replace(/^```json\s*/i, "").replace(/```$/g, "").trim());
          usedModel = resLite.model; usedTier = resLite.usedTier;
        } else {
          const sysFull = `당신은 한국 정통 자평명리학 대가 '별빛운세정원'입니다. 각 항목의 최소 글자수(총합 1만자 이상)를 반드시 채우고, 원국 근거를 직접 인용하며 [소제목]과 줄바꿈(\\n\\n)으로 작성하세요. 내년은 2027년 정미년입니다.`;
          const p1Res = await callGeminiFast({
            apiKey,
            systemInstruction: sysFull,
            prompt: `${fullDataText}\n\n[총평, 원국/용신/지장간/합충 심층 분석, 종합운, 재물/투자운, 개운 처방] JSON(5,500자 이상)을 아주 상세히 작성해주세요.`,
            schema: FULL_PART1_SCHEMA,
            maxTokens: 12288,
          });
          await new Promise((r) => setTimeout(r, 800));
          const p2Res = await callGeminiFast({
            apiKey,
            systemInstruction: sysFull,
            prompt: `${fullDataText}\n\n[커리어/이직운, 연애/인연, 2027년 정미년 대운·세운, 맞춤 질문 해답, 2027년 1~12월 월별 운세 배열 12개] JSON(5,500자 이상)을 아주 상세히 작성해주세요.`,
            schema: FULL_PART2_SCHEMA,
            maxTokens: 12288,
          });
          const part1 = JSON.parse(String(p1Res.text || "{}").replace(/^```json\s*/i, "").replace(/```$/g, "").trim());
          const part2 = JSON.parse(String(p2Res.text || "{}").replace(/^```json\s*/i, "").replace(/```$/g, "").trim());
          reading = { ...part1, ...part2 };
          usedModel = p1Res.model; usedTier = "parallel-fast";
        }

        const totalChars = isLite
          ? (reading.todayFortune?.length || 0) + (reading.briefSajuSummary?.length || 0)
          : [reading.executiveSummary, reading.chartDeepAnalysis, reading.comprehensiveFortune, reading.wealthAndInvestment, reading.careerAndJobChange, reading.loveAndRelationships, reading.newYear2027AndDaewoon, reading.questionAnswer].filter(Boolean).join("").length;

        const birthText = `${body.year}.${String(body.month).padStart(2, "0")}.${String(body.day).padStart(2, "0")} ${body.unknownTime ? "시간 미상" : `${String(body.hour).padStart(2, "0")}:${String(body.minute).padStart(2, "0")}`}`;
        const resultPayload = {
          mode: isLite ? "lite" : "full",
          meta: { name, gender, solarOrLunar: body.isLunar ? (body.isLeapMonth ? "음력(윤달)" : "음력") : "양력", birthText, todayText: koreaTodayText, approxKoreanAge, model: usedModel, usedTier, totalChars },
          chart,
          reading,
        };

        if (authUser && supabase) {
          await supabase.from("saju_history").insert({ user_id: authUser.id, mode: resultPayload.mode, subject_name: name, birth_summary: `${resultPayload.meta.solarOrLunar} ${birthText}`, result_json: resultPayload });
          if (!isLite && REQUIRE_CREDITS) await supabase.from("users").update({ credits: authUser.credits - 1 }).eq("id", authUser.id);
        }
        sajuJobs.set(jobId, { status: "done", result: resultPayload, createdAt: Date.now() });
      } catch (bgErr) {
        sajuJobs.set(jobId, { status: "error", error: `AI 사주 분석 오류: ${bgErr?.message || "다시 시도해주세요."}`, createdAt: Date.now() });
      }
    })();

    res.json({ jobId });
  } catch (err) {
    res.status(500).json({ error: `오류: ${err?.message}` });
  }
});

app.post("/api/compatibility", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey.includes("your_gemini")) return res.status(500).json({ error: "GEMINI_API_KEY를 설정해주세요." });
    const authUser = await getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "2인 정밀 궁합은 카카오 로그인 후 이용하실 수 있습니다." });
    if (REQUIRE_CREDITS && authUser.credits <= 0) return res.status(402).json({ error: "이용권이 부족합니다." });

    const { personA, personB, relationType = "연인·결혼" } = req.body;
    if (!personA?.year || !personB?.year) return res.status(400).json({ error: "두 분의 생년월일을 모두 입력해주세요." });

    let builtA, builtB;
    try { builtA = buildChartObject(personA); builtB = buildChartObject(personB); } catch (e) { return res.status(400).json({ error: `날짜 오류: 음력/윤달 여부를 확인해주세요. (${e.message})` }); }

    const jobId = crypto.randomUUID();
    sajuJobs.set(jobId, { status: "processing", createdAt: Date.now() });

    (async () => {
      try {
        const prompt = `
[관계 유형] ${relationType}
[첫 번째 사람: ${personA.name || "본인"} (${personA.gender === "male" ? "남" : "여"})]
- 원국: ${builtA.chart.pillars.year.korean}년 ${builtA.chart.pillars.month.korean}월 ${builtA.chart.pillars.day.korean}일 ${builtA.chart.pillars.hour ? builtA.chart.pillars.hour.korean + "시" : "(시간미상)"}
- 일간: ${builtA.chart.pillars.day.stem.title} / 오행: 목${builtA.chart.elements.counts["목"]} 화${builtA.chart.elements.counts["화"]} 토${builtA.chart.elements.counts["토"]} 금${builtA.chart.elements.counts["금"]} 수${builtA.chart.elements.counts["수"]}

[두 번째 사람: ${personB.name || "상대방"} (${personB.gender === "male" ? "남" : "여"})]
- 원국: ${builtB.chart.pillars.year.korean}년 ${builtB.chart.pillars.month.korean}월 ${builtB.chart.pillars.day.korean}일 ${builtB.chart.pillars.hour ? builtB.chart.pillars.hour.korean + "시" : "(시간미상)"}
- 일간: ${builtB.chart.pillars.day.stem.title} / 오행: 목${builtB.chart.elements.counts["목"]} 화${builtB.chart.elements.counts["화"]} 토${builtB.chart.elements.counts["토"]} 금${builtB.chart.elements.counts["금"]} 수${builtB.chart.elements.counts["수"]}

두 사람의 일간 합충, 일지(배우자궁) 조화, 오행 상호보완을 근거로 깊이 있고 현실적인 궁합 리포트 JSON(총 4,500자 이상)을 작성해주세요.`.trim();

        const aiRes = await callGeminiFast({
          apiKey,
          systemInstruction: "당신은 한국 정통 궁합 명리학 대가 '별빛운세정원'입니다. 두 사람의 사주를 입체적으로 비교하여 현실적이고 따뜻한 궁합 풀이를 작성하세요.",
          prompt,
          schema: COMPAT_SCHEMA,
          maxTokens: 10240,
        });
        const reading = JSON.parse(String(aiRes.text || "{}").replace(/^```json\s*/i, "").replace(/```$/g, "").trim());
        const resultPayload = { mode: "compat", meta: { nameA: personA.name || "본인", nameB: personB.name || "상대방", relationType, model: aiRes.model }, chartA: builtA.chart, chartB: builtB.chart, reading };

        if (supabase) {
          await supabase.from("saju_history").insert({ user_id: authUser.id, mode: "compat", subject_name: `${resultPayload.meta.nameA} ♥ ${resultPayload.meta.nameB}`, birth_summary: `${relationType} 궁합 (${reading.score}점)`, result_json: resultPayload });
          if (REQUIRE_CREDITS) await supabase.from("users").update({ credits: authUser.credits - 1 }).eq("id", authUser.id);
        }
        sajuJobs.set(jobId, { status: "done", result: resultPayload, createdAt: Date.now() });
      } catch (bgErr) {
        sajuJobs.set(jobId, { status: "error", error: `궁합 분석 오류: ${bgErr?.message}`, createdAt: Date.now() });
      }
    })();

    res.json({ jobId });
  } catch (err) {
    res.status(500).json({ error: `궁합 오류: ${err?.message}` });
  }
});

app.post("/api/saju/followup", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const { contextSummary, question } = req.body;
    if (!question || !String(question).trim()) return res.status(400).json({ error: "질문을 입력해주세요." });
    const aiRes = await callGeminiFast({
      apiKey,
      systemInstruction: "당신은 사주 상담가 '별빛운세정원'입니다. 아래 의뢰인의 사주 원국 정보를 바탕으로 추가 질문에 4~6문장 정도로 명쾌하고 따뜻하게 답해주세요. 일반 한국어 텍스트로 답하세요.",
      prompt: `[의뢰인 사주 요약]\n${contextSummary}\n\n[추가 질문]\n${question}`,
      schema: null,
      maxTokens: 1024,
    });
    res.json({ answer: aiRes.text });
  } catch (err) {
    res.status(500).json({ error: "답변 생성 중 잠시 혼잡이 발생했습니다. 다시 눌러주세요." });
  }
});

app.get("/api/saju/status/:jobId", (req, res) => {
  const job = sajuJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: "error", error: "작업 시간이 초과되었습니다. 다시 시도해주세요." });
  if (job.status === "done") { sajuJobs.delete(req.params.jobId); return res.json({ status: "done", data: job.result }); }
  if (job.status === "error") { sajuJobs.delete(req.params.jobId); return res.json({ status: "error", error: job.error }); }
  res.json({ status: "processing" });
});

app.listen(PORT, "0.0.0.0", () => console.log(`✨ 별빛운세정원 서버 실행: http://0.0.0.0:${PORT}`));
