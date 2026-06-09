# 智慧树题库导出助手

把智慧树已完成答题记录中的题目整理成干净的 Markdown 复习文档。脚本会清洗 Word/CSS 残留、回答正确/错误提示等干扰文本，默认导出题干、选项、参考答案和解析，不导出图片。

## 功能

- **解析页收录**：在 `examPreview` 解析页识别题干、选项、答案和解析，保存到浏览器本地。
- **本节导出**：按当前章节导出 Markdown，文件名默认使用“章-节.md”。
- **全课导出**：在课程页汇总已收录章节，一键保存或下载全课题库。
- **去重合并**：同一道题在答对/答错记录中出现时，按题干和选项去重，并优先补全答案与解析。
- **文本清洗**：去掉 `font-size`、`mso-` 等样式残留，以及“回答错误/正确”提示。
- **本地采集器**：附带 Playwright 只读采集脚本，可基于已登录浏览器从全课历史记录批量导出。

## 安装油猴脚本

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或兼容的用户脚本扩展。
2. 新建脚本，将 [`zhihuishu-question-exporter.user.js`](./zhihuishu-question-exporter.user.js) 全文粘贴保存。
3. 打开智慧树课程页、历史页或解析页，右下角会出现“题目导出 Plus”面板。

## 使用说明

- 在解析页点击 **收录本页**，可把当前页题目保存到浏览器本地。
- 在课程页点击 **开始历史收录**，脚本会尝试逐节进入历史记录并收录解析页。
- 点击 **保存全课** 或 **下载全课**，导出当前浏览器本地已收录的题库。
- 数据保存在当前浏览器的 `localStorage`，清缓存或更换浏览器会导致油猴侧题库不可见。

## 本地全课采集器

如果油猴页面跳转不稳定，推荐使用附带的本地采集器。它连接你已登录的浏览器，通过智慧树历史记录和解析页接口读取题目，只做查看和抓取，不提交作答。

安装依赖：

```powershell
npm install
```

运行前需要启动带 CDP 端口的浏览器并登录智慧树。示例：

```powershell
msedge --remote-debugging-port=9222 --user-data-dir="$env:TEMP\zhs-cdp-profile"
```

登录后，把课程页 URL 传给采集器：

```powershell
node scripts\collect-course-bank.js --start-url "https://ai-smart-course-student-pro.zhihuishu.com/singleCourse/knowledgeStudy/课程ID/班级ID?mapUid=你的mapUid" --resume
```

默认输出到 `outputs/<课程名>-全课题库.md`，旁边会生成 `.raw.json` 和 `.checkpoint.json`，便于断点续跑和核对。

## 隐私说明

- 油猴脚本只在浏览器本地运行，题库数据保存在本机。
- 本地采集器只连接你本机已登录的浏览器，不内置账号密码。
- 仓库不应提交个人题库导出、登录缓存、浏览器 profile 或课程私有参数。

## 支持作者

如果这个脚本帮你省了复习整理时间，欢迎通过 [爱发电](https://ifdian.net/a/jd0512) 支持作者继续维护。

## 开源协议

[MIT](./LICENSE) · Copyright Wan-JD
