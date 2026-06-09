const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const OUT_DIR = path.resolve(__dirname, "../outputs");
const CAPTURE_DIR = path.resolve(__dirname, "captures");

const QUESTION_TYPE_NAMES = {
  1: "单选题",
  2: "多选题",
  3: "填空题",
  4: "问答题",
  9: "组合题",
  10: "听力题",
  11: "听力题",
  14: "判断题",
  15: "填空题",
};

function parseArgs(argv) {
  const options = {
    cdp: "http://127.0.0.1:9222",
    startUrl: "",
    output: "",
    limitLessons: 0,
    maxHistory: 0,
    delayMin: 1200,
    delayMax: 2800,
    historyTimeout: 25000,
    previewTimeout: 30000,
    resume: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--cdp" && next) {
      options.cdp = next;
      i += 1;
    } else if (arg === "--start-url" && next) {
      options.startUrl = next;
      i += 1;
    } else if (arg === "--output" && next) {
      options.output = next;
      i += 1;
    } else if (arg === "--limit-lessons" && next) {
      options.limitLessons = Number(next) || 0;
      i += 1;
    } else if (arg === "--max-history" && next) {
      options.maxHistory = Number(next) || 0;
      i += 1;
    } else if (arg === "--delay-min" && next) {
      options.delayMin = Number(next) || options.delayMin;
      i += 1;
    } else if (arg === "--delay-max" && next) {
      options.delayMax = Number(next) || options.delayMax;
      i += 1;
    } else if (arg === "--resume") {
      options.resume = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/collect-course-bank.js --start-url <course-url> [options]

Options:
  --cdp <url>            CDP address for the logged-in browser. Default: http://127.0.0.1:9222
  --start-url <url>      Course learnPage or singleCourse/knowledgeStudy URL.
  --output <file>        Markdown output path. Default: outputs/<course>-全课题库.md
  --limit-lessons <n>    Only collect the first n lessons, useful for testing.
  --max-history <n>      Only collect the newest n history records per lesson. Default: all visible history.
  --delay-min <ms>       Minimum delay between page reads. Default: 1200
  --delay-max <ms>       Maximum delay between page reads. Default: 2800
  --resume               Resume from an existing .raw.json beside the output file.
`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle(options, label = "") {
  const min = Math.max(0, Number(options.delayMin) || 0);
  const max = Math.max(min, Number(options.delayMax) || min);
  const wait = Math.round(min + Math.random() * (max - min));
  if (wait > 0) {
    console.log(`  wait ${wait}ms${label ? ` before ${label}` : ""}`);
    await sleep(wait);
  }
}

function safeFilename(value) {
  return String(value || "智慧树课程题库")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function cleanRichText(value) {
  let text = String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<img\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  text = text
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const valueCode = Number(code);
      return Number.isFinite(valueCode) ? String.fromCodePoint(valueCode) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const valueCode = parseInt(code, 16);
      return Number.isFinite(valueCode) ? String.fromCodePoint(valueCode) : "";
    });

  const cssDeclaration =
    /(?:^|[\s"'<>;])(?:line-height|font-size|font-family|mso-[\w-]+|color|background(?:-color)?|text-align|text-indent|letter-spacing|word-break|white-space|vertical-align|margin|padding)\s*:\s*[^;\n<>"]*;?/gi;
  for (let i = 0; i < 8; i += 1) {
    const next = text.replace(cssDeclaration, " ");
    if (next === text) break;
    text = next;
  }

  return text
    .replace(/[🥳😔]?\s*回答(?:正确|错误)[~～!！]?(?:可以看看下面的解析哦[~～]?)?/g, " ")
    .replace(/["']?\s*>\s*/g, " ")
    .replace(/^[;"'\s]+/, "")
    .replace(/[;"'\s]+$/, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeForKey(value) {
  return cleanRichText(value).replace(/\s+/g, "");
}

function labelForSort(sort, index) {
  const value = Number(sort || index + 1);
  if (value >= 1 && value <= 26) return String.fromCharCode(64 + value);
  return String(index + 1);
}

function answerForQuestion(question, sortedOptions) {
  const type = Number(question.questionType);
  const correctOptions = sortedOptions.filter((option) => Number(option.isCorrect) === 1);

  if ([1, 2, 14].includes(type) && correctOptions.length) {
    return correctOptions.map((option) => option.label).join("、");
  }

  if (correctOptions.length) {
    return correctOptions.map((option) => cleanRichText(option.content)).filter(Boolean).join("；");
  }

  if (question.result) return cleanRichText(question.result).replace(/[,，]\s*/g, "、");

  const correctAnswer = question.userAnswerDtos?.find((item) => item.correctAnswer)?.correctAnswer;
  return cleanRichText(correctAnswer || "");
}

function convertQuestion(rawQuestion, context = {}) {
  const sortedOptions = [...(rawQuestion.optionDtos || [])]
    .sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0))
    .map((option, index) => ({
      ...option,
      label: labelForSort(option.sort, index),
      text: cleanRichText(option.content),
    }))
    .filter((option) => option.text);

  const parentStem = context.parentStem ? [context.parentStem] : [];
  const stem = [...parentStem, cleanRichText(rawQuestion.content)].filter(Boolean);
  const analysis = cleanRichText(rawQuestion.analysisDto?.analyze || context.analysis || "");
  const type = rawQuestion.questionTypeName || QUESTION_TYPE_NAMES[rawQuestion.questionType] || "题目";

  return {
    id: rawQuestion.id || rawQuestion.questionId || "",
    type,
    stem,
    options: sortedOptions.map((option) => ({ label: option.label, text: option.text })),
    answer: answerForQuestion(rawQuestion, sortedOptions),
    analysis,
  };
}

function flattenQuestions(rawQuestions) {
  const output = [];
  for (const rawQuestion of rawQuestions || []) {
    const parentStem = cleanRichText(rawQuestion.content);
    if (Array.isArray(rawQuestion.childQuestionDtos) && rawQuestion.childQuestionDtos.length) {
      rawQuestion.childQuestionDtos.forEach((child, index) => {
        output.push(
          convertQuestion(
            {
              ...child,
              analysisDto: child.analysisDto || rawQuestion.analysisDto,
              questionTypeName: child.questionTypeName || QUESTION_TYPE_NAMES[child.questionType],
            },
            { parentStem: `${parentStem}\n（${index + 1}）`, analysis: rawQuestion.analysisDto?.analyze }
          )
        );
      });
    } else {
      output.push(convertQuestion(rawQuestion));
    }
  }
  return output;
}

function questionKey(question) {
  const stem = question.stem.map(normalizeForKey).join("");
  const options = question.options.map((option) => `${option.label}.${normalizeForKey(option.text)}`).join("|");
  return `${question.type}|${stem}|${options}`.slice(0, 1200);
}

function mergeQuestion(target, incoming, source) {
  if (!target.answer && incoming.answer) target.answer = incoming.answer;
  if (!target.analysis && incoming.analysis) target.analysis = incoming.analysis;
  if (!target.options.length && incoming.options.length) target.options = incoming.options;
  if (!target.stem.length && incoming.stem.length) target.stem = incoming.stem;
  if (source) target.sources.push(source);
  return target;
}

function dedupeInto(list, incomingQuestions, source) {
  const byKey = new Map(list.map((question) => [question.key, question]));
  let added = 0;
  let updated = 0;

  for (const incoming of incomingQuestions) {
    const key = questionKey(incoming);
    const existing = byKey.get(key);
    if (!existing) {
      const stored = { ...incoming, key, sources: source ? [source] : [] };
      list.push(stored);
      byKey.set(key, stored);
      added += 1;
      continue;
    }

    const before = `${existing.answer}|${existing.analysis}|${existing.options.length}`;
    mergeQuestion(existing, incoming, source);
    const after = `${existing.answer}|${existing.analysis}|${existing.options.length}`;
    if (after !== before) updated += 1;
  }

  return { added, updated };
}

function markdownQuestion(question, index) {
  const parts = [`#### 第 ${index + 1} 题（${question.type}）`];
  parts.push(`**题干：**\n\n${question.stem.join("\n") || "（空）"}`);

  if (question.options.length) {
    parts.push(
      `**选项：**\n\n${question.options.map((option) => `- ${option.label}. ${option.text}`).join("\n")}`
    );
  }

  if (question.answer) parts.push(`**参考答案：** ${question.answer}`);
  if (question.analysis) parts.push(`**解析：**\n\n${question.analysis}`);
  return parts.join("\n\n");
}

function buildMarkdown(course) {
  const totalQuestions = course.lessons.reduce((sum, lesson) => sum + lesson.questions.length, 0);
  const lessonsWithQuestions = course.lessons.filter((lesson) => lesson.questions.length).length;
  const lines = [
    `# ${course.title}`,
    `导出时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    `章节数量：${lessonsWithQuestions}`,
    `题目总数：${totalQuestions}`,
    "",
    "---",
    "",
  ];

  let currentChapter = "";
  for (const lesson of course.lessons) {
    if (!lesson.questions.length) continue;
    if (lesson.chapter !== currentChapter) {
      currentChapter = lesson.chapter;
      lines.push(`## ${currentChapter || "未分章"}`, "");
    }
    lines.push(`### ${lesson.name}`, "");
    lines.push(`题目数量：${lesson.questions.length}`, "");
    lines.push(lesson.questions.map(markdownQuestion).join("\n\n---\n\n"));
    lines.push("", "---", "");
  }

  if (!totalQuestions) lines.push("没有从历史解析页收录到题目。", "");
  return lines.join("\n").replace(/\n{4,}/g, "\n\n\n");
}

function outputPaths(options, courseTitle) {
  const markdownPath = path.resolve(options.output || path.join(OUT_DIR, `${safeFilename(courseTitle)}-全课题库.md`));
  const rawPath = markdownPath.replace(/\.md$/i, ".raw.json");
  const checkpointPath = markdownPath.replace(/\.md$/i, ".checkpoint.json");
  return { markdownPath, rawPath, checkpointPath };
}

function writeOutputs(course, paths) {
  course.totalQuestions = course.lessons.reduce((sum, lesson) => sum + lesson.questions.length, 0);
  const markdown = buildMarkdown(course);
  fs.writeFileSync(paths.markdownPath, `\ufeff${markdown}`, "utf8");
  fs.writeFileSync(paths.rawPath, JSON.stringify(course, null, 2), "utf8");
  fs.writeFileSync(
    paths.checkpointPath,
    JSON.stringify(
      {
        savedAt: new Date().toISOString(),
        totalQuestions: course.totalQuestions,
        lessonsScanned: course.lessons.filter((lesson) => lesson.scanned).length,
        lessonsWithQuestions: course.lessons.filter((lesson) => lesson.questions.length).length,
        lessons: course.lessons.map((lesson) => ({
          chapter: lesson.chapter,
          name: lesson.name,
          scanned: Boolean(lesson.scanned),
          historyCount: lesson.historyCount,
          questionCount: lesson.questions.length,
        })),
      },
      null,
      2
    ),
    "utf8"
  );
}

function readResumeCourse(paths) {
  if (!fs.existsSync(paths.rawPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.rawPath, "utf8"));
    if (!parsed || !Array.isArray(parsed.lessons)) return null;
    return parsed;
  } catch (error) {
    return null;
  }
}

function mergeResumeLessons(freshLessons, savedLessons) {
  const savedById = new Map((savedLessons || []).map((lesson) => [String(lesson.id || ""), lesson]));
  return freshLessons.map((lesson) => {
    const saved = savedById.get(String(lesson.id || ""));
    if (!saved) return lesson;
    return {
      ...lesson,
      questions: Array.isArray(saved.questions) ? saved.questions : [],
      historyCount: saved.historyCount || 0,
      scanned: Boolean(saved.scanned),
    };
  });
}

function encodeNodeNameForHistory(name) {
  return Buffer.from(encodeURIComponent(JSON.stringify(name)), "utf8").toString("base64");
}

function parseIdsFromStartUrl(startUrl) {
  const url = new URL(startUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  let courseId = "";
  let nodeId = "";
  let classId = "";

  if (parts[0] === "learnPage") {
    courseId = parts[1] || "";
    nodeId = parts[2] || "";
    classId = parts[3] || "";
  } else if (parts[0] === "singleCourse" && parts[1] === "knowledgeStudy") {
    courseId = parts[2] || "";
    classId = parts[3] || "";
  }

  return {
    origin: url.origin,
    courseId,
    nodeId,
    classId,
    mapUid: url.searchParams.get("mapUid") || "",
  };
}

function historyUrl(meta, lesson) {
  const params = new URLSearchParams({
    mapUid: meta.mapUid,
    catalogActiveTab: "personal",
    isFreeExam: String(lesson.freeExam || 0),
    nodeName: encodeNodeNameForHistory(lesson.name),
  });
  return `${meta.origin}/masteryHistory/${meta.courseId}/${meta.classId}/${lesson.id}?${params.toString()}`;
}

function previewUrl(meta, lesson, history) {
  const params = new URLSearchParams({
    from: "history",
    nodeName: lesson.name,
  });
  return `${meta.origin}/examPreview/${meta.courseId}/${history.paperId}/${history.examTestId}/${lesson.id}/${meta.classId}?${params.toString()}`;
}

async function installReadOnlyRoutes(page) {
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    const isPotentialSideEffect =
      /\/stu\/task\/saveStudentPointLog\b/.test(url) ||
      /\/stu\/studyRecord\//.test(url) ||
      /\/stu\/exam\/questions-paper(?:\?|$)/.test(url);

    if (isPotentialSideEffect) {
      await route.abort("blockedbyclient").catch(() => {});
      return;
    }

    await route.continue().catch(() => {});
  });
}

function isClosedTargetError(error) {
  return /Target page, context or browser has been closed|Browser has been closed|Page closed|browser has disconnected/i.test(
    String(error && (error.stack || error.message || error))
  );
}

async function responseJson(response) {
  const text = await response.text();
  return JSON.parse(text);
}

async function gotoAndWaitForJson(page, url, matcher, label, timeout) {
  const responsePromise = page.waitForResponse((response) => matcher(response.url()), { timeout });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  const response = await responsePromise;
  const json = await responseJson(response);
  if (json.code !== 200 && json.code !== 0) {
    throw new Error(`${label} returned code ${json.code}: ${json.message || ""}`);
  }
  return json;
}

function flattenLessons(knowledgeData) {
  const lessons = [];
  for (const theme of knowledgeData.themeList || []) {
    for (const subTheme of theme.subThemeList || []) {
      for (const knowledge of subTheme.knowledgeList || []) {
        lessons.push({
          id: String(knowledge.knowledgeId || ""),
          name: cleanRichText(knowledge.knowledgeName),
          chapter: cleanRichText(theme.themeName),
          subChapter: subTheme.themeName === "default" ? "" : cleanRichText(subTheme.themeName),
          freeExam: knowledge.freeExam || 0,
          finishedResourceCount: knowledge.finishedResourceCount || 0,
          resourceCount: knowledge.resourceCount || 0,
          questions: [],
          historyCount: 0,
        });
      }
    }
  }
  return lessons.filter((lesson) => lesson.id && lesson.name);
}

async function collectCourseOutline(page, options, meta) {
  const json = await gotoAndWaitForJson(
    page,
    options.startUrl,
    (url) => url.includes("/stu/knowledge-study/get-course-knowledge-dic"),
    "course outline",
    options.previewTimeout
  );

  await page.waitForTimeout(1200);
  const pageTitle = await page
    .evaluate(() => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const firstLine = (document.body.innerText || "").split("\n").map(clean).find(Boolean);
      return firstLine || document.title || "智慧树课程题库";
    })
    .catch(() => "智慧树课程题库");

  if (!meta.mapUid) {
    meta.mapUid = await page.evaluate(() => localStorage.getItem("mapUid") || "").catch(() => "");
  }

  const lessons = flattenLessons(json.data || {});
  return { title: pageTitle, lessons };
}

async function collectHistory(page, meta, lesson, options) {
  const json = await gotoAndWaitForJson(
    page,
    historyUrl(meta, lesson),
    (url) => url.includes("/stu/mastery-statistics/mastery-levels-list"),
    "history list",
    options.historyTimeout
  );

  const all = [...(json.data?.list || [])];
  const total = Number(json.data?.total || all.length);

  while (all.length < total) {
    const nextButton = page.locator(".el-pagination button.btn-next:not([disabled])");
    const count = await nextButton.count().catch(() => 0);
    if (!count) break;

    const responsePromise = page.waitForResponse(
      (response) => response.url().includes("/stu/mastery-statistics/mastery-levels-list"),
      { timeout: options.historyTimeout }
    );
    await nextButton.click({ timeout: 5000 }).catch(() => null);
    const response = await responsePromise.catch(() => null);
    if (!response) break;
    const nextJson = await responseJson(response).catch(() => null);
    const nextList = nextJson?.data?.list || [];
    if (!nextList.length) break;
    all.push(...nextList);
  }

  const practiceHistory = all.filter((item) => Number(item.examType) === 1 && item.paperId && item.examTestId);
  return options.maxHistory > 0 ? practiceHistory.slice(0, options.maxHistory) : practiceHistory;
}

async function collectPreview(page, meta, lesson, history, options) {
  const json = await gotoAndWaitForJson(
    page,
    previewUrl(meta, lesson, history),
    (url) => url.includes("/stu/exam/questions-paper-result-page"),
    "exam preview",
    options.previewTimeout
  );

  return flattenQuestions(json.data?.aiExamQuestionInfo || []);
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.startUrl) {
    printHelp();
    throw new Error("Missing required --start-url.");
  }

  ensureDir(OUT_DIR);
  ensureDir(CAPTURE_DIR);

  const meta = parseIdsFromStartUrl(options.startUrl);
  if (!meta.courseId || !meta.classId) {
    throw new Error("Cannot parse courseId/classId from --start-url. Please provide a learnPage URL.");
  }

  const browser = await chromium.connectOverCDP(options.cdp);
  const context = browser.contexts()[0];
  if (!context) throw new Error("No browser context found. Please open and log in to the CDP browser first.");

  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await installReadOnlyRoutes(page);

  try {
    console.log("[1/4] Reading course outline...");
    const outline = await collectCourseOutline(page, options, meta);
    let lessons = outline.lessons;
    if (options.limitLessons > 0) lessons = lessons.slice(0, options.limitLessons);
    const paths = outputPaths(options, outline.title);
    const resumeCourse = options.resume ? readResumeCourse(paths) : null;
    if (resumeCourse) {
      lessons = mergeResumeLessons(lessons, resumeCourse.lessons);
    }

    console.log(`Course: ${outline.title}`);
    console.log(`Lessons found: ${outline.lessons.length}${options.limitLessons ? `, collecting first ${lessons.length}` : ""}`);
    if (resumeCourse) {
      const resumedQuestions = lessons.reduce((sum, lesson) => sum + lesson.questions.length, 0);
      const resumedScanned = lessons.filter((lesson) => lesson.scanned).length;
      console.log(`Resume: loaded ${resumedQuestions} saved questions, ${resumedScanned} scanned lessons`);
    }

    const course = {
      title: outline.title,
      source: options.startUrl,
      lessons,
      totalQuestions: 0,
    };
    writeOutputs(course, paths);

    for (let i = 0; i < lessons.length; i += 1) {
      const lesson = lessons[i];
      const display = `${lesson.chapter}-${lesson.name}`;
      if (lesson.scanned) {
        console.log(`[${i + 1}/${lessons.length}] ${display} (resume skip, ${lesson.questions.length} saved)`);
        continue;
      }
      console.log(`[${i + 1}/${lessons.length}] ${display}`);

      let histories = [];
      try {
        await throttle(options, "history list");
        histories = await collectHistory(page, meta, lesson, options);
      } catch (error) {
        console.log(`  history skipped: ${error.message}`);
        lesson.scanned = true;
        writeOutputs(course, paths);
        if (isClosedTargetError(error)) throw error;
        continue;
      }

      lesson.historyCount = histories.length;
      if (!histories.length) {
        console.log("  no history records");
        lesson.scanned = true;
        writeOutputs(course, paths);
        continue;
      }

      for (let h = 0; h < histories.length; h += 1) {
        const history = histories[h];
        try {
          await throttle(options, `preview ${h + 1}/${histories.length}`);
          const questions = await collectPreview(page, meta, lesson, history, options);
          const source = {
            createTime: history.createTime || "",
            mastery: history.mastery,
            paperId: history.paperId,
            examTestId: history.examTestId,
          };
          const result = dedupeInto(lesson.questions, questions, source);
          console.log(
            `  history ${h + 1}/${histories.length}: returned ${questions.length}, +${result.added}, updated ${result.updated}, lesson total ${lesson.questions.length}`
          );
          writeOutputs(course, paths);
        } catch (error) {
          console.log(`  preview skipped (${history.paperId}): ${error.message}`);
          writeOutputs(course, paths);
          if (isClosedTargetError(error)) throw error;
        }
      }
      lesson.scanned = true;
      writeOutputs(course, paths);
    }

    writeOutputs(course, paths);

    const summary = {
      course: course.title,
      lessonsScanned: lessons.filter((lesson) => lesson.scanned).length,
      lessonsWithQuestions: lessons.filter((lesson) => lesson.questions.length).length,
      totalQuestions: course.totalQuestions,
      markdownPath: paths.markdownPath,
      rawPath: paths.rawPath,
      checkpointPath: paths.checkpointPath,
    };
    fs.writeFileSync(path.join(CAPTURE_DIR, "collect-course-bank-summary.json"), JSON.stringify(summary, null, 2), "utf8");
    console.log("[done]");
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await page.close().catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
