const dayjs = require("dayjs");
const rssParser = require('rss-parser');
const turndown = require('turndown');
const Api2d = require('api2d');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fetch = require('cross-fetch');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');


// 解析 shell 命令字符串为参数数组，正确处理引号内的空格
function parseShellArgs(str) {
    const args = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (inQuote) {
            if (ch === quoteChar) {
                inQuote = false;
            } else {
                current += ch;
            }
        } else if (ch === '"' || ch === "'") {
            inQuote = true;
            quoteChar = ch;
        } else if (ch === ' ') {
            if (current) {
                args.push(current);
                current = '';
            }
        } else {
            current += ch;
        }
    }
    if (current) args.push(current);
    return args;
}


// ============================================================
// 错误处理增强：错误分类、延迟重试、失败通知、去重
// ============================================================

// 错误分类枚举
const ErrorType = {
    XML_PARSE: 'xml-parse',
    TIMEOUT: 'timeout',
    HTTP_ERROR: 'http-error',
    EMPTY_CONTENT: 'empty-content',
    NETWORK: 'network',
    UNKNOWN: 'unknown'
};

// 错误通知去重缓存（task_id -> last_notify_time）
const notifyCache = new Map();

// TTL 清理机制：每小时清理过期条目，防止内存泄漏
const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000; // 30 分钟内不重复通知
const CACHE_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 小时
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, time] of notifyCache) {
        if (now - time > NOTIFY_COOLDOWN_MS) {
            notifyCache.delete(key);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log('[Cache Cleanup] 清理了 ' + cleaned + ' 条过期通知缓存，剩余 ' + notifyCache.size + ' 条');
    }
}, CACHE_CLEANUP_INTERVAL);

// 延迟重试配置
// 从环境变量 RETRY_INTERVALS 解析重试间隔（逗号分隔秒数），默认 10s,30s,60s,300s,600s
const DEFAULT_RETRY_INTERVALS_SEC = [10, 30, 60, 300, 600];
function parseRetryIntervals() {
    const env = process.env.RETRY_INTERVALS;
    if (!env) return DEFAULT_RETRY_INTERVALS_SEC.map(s => s * 1000);
    try {
        const parsed = env.split(',').map(s => parseInt(s.trim(), 10));
        if (parsed.some(isNaN) || parsed.length === 0) {
            console.warn('[Retry] RETRY_INTERVALS 格式错误，使用默认值');
            return DEFAULT_RETRY_INTERVALS_SEC.map(s => s * 1000);
        }
        return parsed.map(s => s * 1000);
    } catch (e) {
        console.warn('[Retry] RETRY_INTERVALS 解析失败，使用默认值:', e.message);
        return DEFAULT_RETRY_INTERVALS_SEC.map(s => s * 1000);
    }
}
const RETRY_INTERVALS_MS = parseRetryIntervals();
const MAX_RETRIES = RETRY_INTERVALS_MS.length; // 重试次数 = 间隔数组长度

/**
 * 错误分类器
 * 根据错误信息判断错误类型
 */
function classifyError(error) {
    const message = (error.message || '').toLowerCase();
    const code = error.code || '';

    // XML 解析错误
    if (message.includes('unable to parse xml') || 
        message.includes('invalid xml') ||
        message.includes('xml parse error')) {
        return ErrorType.XML_PARSE;
    }

    // 网络超时
    if (message.includes('timeout') || 
        message.includes('timed out') ||
        code === 'ETIMEDOUT' ||
        code === 'ESOCKETTIMEDOUT') {
        return ErrorType.TIMEOUT;
    }

    // HTTP 错误
    if (message.includes('status code') || 
        message.includes('http error') ||
        message.includes('404') ||
        message.includes('500') ||
        message.includes('502') ||
        message.includes('503')) {
        return ErrorType.HTTP_ERROR;
    }

    // 网络连接错误
    if (message.includes('enotfound') || 
        message.includes('econnrefused') ||
        message.includes('econnreset') ||
        message.includes('network') ||
        code === 'ENOTFOUND' ||
        code === 'ECONNREFUSED' ||
        code === 'ECONNRESET') {
        return ErrorType.NETWORK;
    }

    return ErrorType.UNKNOWN;
}

/**
 * 获取错误类型的中文描述
 */
function getErrorTypeLabel(errorType) {
    const labels = {
        [ErrorType.XML_PARSE]: 'XML解析错误',
        [ErrorType.TIMEOUT]: '网络超时',
        [ErrorType.HTTP_ERROR]: 'HTTP错误',
        [ErrorType.EMPTY_CONTENT]: '内容为空',
        [ErrorType.NETWORK]: '网络连接错误',
        [ErrorType.UNKNOWN]: '未知错误'
    };
    return labels[errorType] || '未知错误';
}

/**
 * 记录错误日志（带时间戳和分类）
 * 使用异步写入避免阻塞事件循环
 */
function logError(taskTitle, errorType, error, feedUrl) {
    const timestamp = dayjs().format('YYYY-MM-DD HH:mm:ss');
    const logEntry = {
        timestamp,
        task: taskTitle,
        errorType,
        message: error.message || String(error),
        feedUrl
    };

    // 输出到控制台
    console.error('[' + timestamp + '] 任务失败: ' + taskTitle);
    console.error('  错误类型: ' + getErrorTypeLabel(errorType));
    console.error('  错误信息: ' + (error.message || String(error)));
    console.error('  RSS源: ' + feedUrl);

    // 异步写入错误日志文件
    try {
        const logDir = path.join(__dirname, 'data');
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        const logFile = path.join(logDir, 'error.log');
        const logLine = '[' + timestamp + '] [' + errorType + '] ' + taskTitle + ' - ' + (error.message || String(error)) + ' (' + feedUrl + ')\n';
        
        // 使用异步写入，不阻塞事件循环
        fs.appendFile(logFile, logLine, (err) => {
            if (err) {
                console.error('写入错误日志失败:', err.message);
            }
        });
    } catch (e) {
        console.error('写入错误日志失败:', e.message);
    }

    return logEntry;
}

/**
 * 检查是否应该发送通知（去重）
 */
function shouldNotify(taskId) {
    const now = Date.now();
    const lastNotify = notifyCache.get(taskId);

    if (lastNotify && (now - lastNotify) < NOTIFY_COOLDOWN_MS) {
        console.log('任务 ' + taskId + ' 在 ' + (NOTIFY_COOLDOWN_MS / 60000) + ' 分钟内已通知过，跳过重复通知');
        return false;
    }

    notifyCache.set(taskId, now);
    return true;
}

/**
 * 发送失败通知（通过 DingTalk webhook）
/**
 * 发送失败通知（通过所有 task.keys 通道，和成功推送一致）
 */
async function sendFailureNotification(task, errorType, error, retrySummary) {
    // 检查去重
    if (!shouldNotify(task.id)) {
        return { code: 0, message: '已通知过，跳过' };
    }

    // 构建完整重试摘要消息
    const title = '⚠️ RSS任务失败通知（' + (retrySummary ? retrySummary.totalAttempts : 1) + '次尝试均失败）';
    const errorLabel = getErrorTypeLabel(errorType);
    const durationSec = retrySummary ? Math.round(retrySummary.totalDurationMs / 1000) : 0;

    let messageLines = [
        '**任务名称**: ' + task.title,
        '**RSS源**: ' + task.feed,
        '**总尝试次数**: ' + (retrySummary ? retrySummary.totalAttempts : 1) + ' 次',
        '**总耗时**: ' + durationSec + ' 秒',
        '',
        '**重试详情**:'
    ];

    if (retrySummary && retrySummary.attemptLog) {
        for (const a of retrySummary.attemptLog) {
            messageLines.push('  第 ' + a.attempt + ' 次: [' + getErrorTypeLabel(a.errorType) + '] ' + a.message);
        }
    } else {
        messageLines.push('  第 1 次: [' + errorLabel + '] ' + (error.message || String(error)));
    }

    messageLines.push('');
    messageLines.push('**最后错误**: [' + errorLabel + '] ' + (retrySummary ? retrySummary.lastError : (error.message || String(error))));
    messageLines.push('');
    messageLines.push('任务已跳过，请检查RSS源是否可用。');

    const titlePlain = title.replace(/[\*]/g, '');
    const desp = messageLines.join('\n');

    // 遍历 task.keys 所有通道发送通知（和成功推送一致）
    const keys = task.keys ? task.keys.split("\n").map(item => item.trim()) : [];
    const unique_keys = [...new Set(keys)];
    const results = [];

    for (const skey of unique_keys) {
        let ret = { "code": -1, "message": "unknown key type" };

        if (skey.toLowerCase().substring(0, 3) == "sct") {
            ret = await sc_send(titlePlain, desp, titlePlain.substring(0, 64), String(skey).trim());
        } else if (skey.toLowerCase().substring(0, 4) == "http") {
            try {
                const form = new FormData();
                form.append('task_id', task.id);
                form.append('task_title', task.title);
                form.append('text', titlePlain);
                form.append('title', titlePlain);
                form.append('link', task.feed);
                form.append('desp', desp);
                const response = await fetch(skey, { method: 'POST', body: form });
                ret = await response.json();
            } catch (err) {
                ret = { "code": 9, "message": "webhook " + err.message };
            }
        } else if (skey.toLowerCase().substring(0, 12) == "apprise:raw ") {
            const { spawn } = require("child_process");
            const rawArgs = parseShellArgs(skey.substring(12));
            const child = spawn('apprise', [...rawArgs, '-t', titlePlain, '-b', desp]);
            child.stdout.on('data', (data) => console.log('stdout: ' + data));
            child.stderr.on('data', (data) => console.log('stderr: ' + data));
            child.on('error', (error) => console.log('error: ' + error.message));
            ret = { "code": 0, "message": "sent to apprise" };
        } else if (skey.toLowerCase().substring(0, 8) == "apprise ") {
            const { spawn } = require("child_process");
            const appriseArgs = parseShellArgs(skey.substring(8));
            const child = spawn('apprise', [...appriseArgs, '-t', titlePlain, '-b', desp]);
            child.stdout.on('data', (data) => console.log('stdout: ' + data));
            child.stderr.on('data', (data) => console.log('stderr: ' + data));
            child.on('error', (error) => console.log('error: ' + error.message));
            ret = { "code": 0, "message": "sent to apprise" };
        }

        console.log('失败通知发送结果:', skey.substring(0, 20) + '...', ret);
        results.push({ skey: skey.substring(0, 30), result: ret });
    }

    return results;
}

/**
 * 延迟等待
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带重试的 RSS 解析
 */
async function parseRSSWithRetry(parser, feedUrl, taskTitle) {
    let lastError = null;
    let errorType = null;
    const attemptLog = []; // 记录每次尝试的错误信息
    const startTime = Date.now();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            // 如果是重试，先延迟
            if (attempt > 0) {
                const waitMs = RETRY_INTERVALS_MS[attempt - 1] || RETRY_INTERVALS_MS[RETRY_INTERVALS_MS.length - 1];
                console.log('[' + taskTitle + '] 第 ' + attempt + ' 次重试，等待 ' + (waitMs / 1000) + ' 秒...');
                await delay(waitMs);
            }

            const feed = await parser.parseURL(feedUrl);

            // 检查内容是否为空
            if (!feed || !feed.items || feed.items.length === 0) {
                throw new Error('RSS内容为空或无条目');
            }

            // 成功则返回
            return { success: true, feed };

        } catch (error) {
            lastError = error;
            errorType = classifyError(error);
            attemptLog.push({ attempt: attempt + 1, errorType, message: error.message });
            console.log('[' + taskTitle + '] 尝试 ' + (attempt + 1) + '/' + (MAX_RETRIES + 1) + ' 失败: [' + errorType + '] ' + error.message);

            // 如果是最后一次尝试，不再重试
            if (attempt >= MAX_RETRIES) {
                break;
            }
        }
    }

    // 所有重试都失败，返回完整重试摘要
    const totalDuration = Date.now() - startTime;
    return { 
        success: false, 
        error: lastError, 
        errorType: errorType || ErrorType.UNKNOWN,
        retrySummary: {
            totalAttempts: attemptLog.length,
            attemptLog,
            totalDurationMs: totalDuration,
            lastError: lastError ? lastError.message : String(lastError)
        }
    };
}

// ============================================================
// 主处理函数（已增强错误处理）
// ============================================================

async function processTask(task, isTest = false) {
    try {
        let do_task = false;

        if (isTest) {
            do_task = true;
        } else {
            if (!task.last_time) do_task = true;
            if (task.last_time && dayjs(task.last_time).add(task.minutes, 'minutes').isBefore(dayjs())) {
                do_task = true;
            }
        }

        if (!do_task) return;

        let requestOptions = {};
        const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
        const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;

        if (httpProxy) {
            requestOptions.agent = new HttpsProxyAgent(httpProxy);
        } else {
            if (httpsProxy) requestOptions.agent = new HttpsProxyAgent(httpsProxy);
        }

        const parser = new rssParser({ timeout: 10000, requestOptions });

        // 使用带重试的 RSS 解析
        const parseResult = await parseRSSWithRetry(parser, task.feed, task.title);

        if (!parseResult.success) {
            // 解析失败，记录错误并发送通知
            const { error, errorType, retrySummary } = parseResult;
            logError(task.title, errorType, error, task.feed);
            
            // 发送失败通知（带去重，通过所有 task.keys 通道）
            await sendFailureNotification(task, errorType, error, retrySummary);

            // 更新任务状态（标记为失败，但不阻止其他任务）
            if (!isTest) {
                task.last_time = dayjs().format("YYYY-MM-DD HH:mm:ss");
                task.last_error = {
                    type: errorType,
                    message: error.message,
                    time: task.last_time
                };
            }

            return { 
                success: false, 
                error: error.message, 
                errorType,
                skipped: true 
            };
        }

        // 解析成功，继续正常处理
        const feed = parseResult.feed;
        const last = feed.items[0];
        const last_content = last.guid || last.link;
        const old_content = task.last_content;

        if (!isTest) {
            task.last_time = dayjs().format("YYYY-MM-DD HH:mm:ss");
            task.last_content = last_content;
            // 清除之前的错误状态
            delete task.last_error;
        }

        if (isTest || (old_content && old_content != last_content)) {
            console.log("Processing task", task.title);

            const last_title = last.title?.toLowerCase();

            if (task['keyword']) {
                const keywords = task['keyword'].toLowerCase().split("|");
                let found = false;
                for (const keyword of keywords) {
                    if (last_title.indexOf(keyword) >= 0) found = true;
                }
                if (!found) {
                    console.log('白名单跳过，' + task['keyword']);
                    return;
                }
            }

            if (task['bad_keyword']) {
                const bad_keywords = task['bad_keyword'].toLowerCase().split("|");
                let found = false;
                for (const bad_keyword of bad_keywords) {
                    if (last_title.indexOf(bad_keyword) >= 0) found = true;
                }
                if (found) {
                    console.log('黑名单跳过，' + task['bad_keyword']);
                    return;
                }
            }

            const keys = task.keys ? task.keys.split("\n").map(item => item.trim()) : [];
            const unique_keys = [...new Set(keys)];

            const sendResults = [];

            for (const skey of unique_keys) {
                const c = new turndown();
                const title = task.title + ' 更新了';
                const short = (last.title || '').substring(0, 64);
                const out = last.content;
                let desp = (last.title || '') + '\n' + c.turndown(out) + '\n' + (last.link || '');

                if (last.content && parseInt(task.translate) > 0 && process.env.OPENAI_KEY) {
                    const max_len = parseInt(process.env.TRANSLATE_MAX_LEN) > 10 ? parseInt(process.env.TRANSLATE_MAX_LEN) : 8000;
                    const ret0 = await translate(desp.substring(0, max_len));
                    if (ret0 && ret0.result) {
                        desp = ret0.result + '\n\n\n\n---------\n\n\n\n' + desp;
                    }
                }

                let ret = { "code": -1, "message": "Bad Key" };

                if (skey.toLowerCase().substring(0, 3) == "sct") {
                    ret = await sc_send(title, desp, short, String(skey).trim());
                } else if (skey.toLowerCase().substring(0, 4) == "http") {
                    const form = new FormData();
                    form.append('task_id', task['id']);
                    form.append('task_title', task['title']);
                    form.append('text', last.title);
                    form.append('title', last.title);
                    form.append('link', last.link);
                    form.append('desp', last.content);
                    try {
                        const response = await fetch(skey, {
                            method: 'POST',
                            body: form
                        });
                        ret = await response.json();
                    } catch (error) {
                        ret = { "code": 9, "message": "webhook " + error };
                    }
                } else if (skey.toLowerCase().substring(0, 12) == "apprise:raw ") {
                    ret = { "code": 0, "message": "sent to apprise" };
                    const { spawn } = require("child_process");
                    const rawArgs = parseShellArgs(skey.substring(12));
                    const child = spawn('apprise', [...rawArgs, '-t', title, '-b', last.content || '']);
                    child.stdout.on('data', (data) => console.log('stdout: ' + data));
                    child.stderr.on('data', (data) => console.log('stderr: ' + data));
                    child.on('error', (error) => console.log('error: ' + error.message));
                } else if (skey.toLowerCase().substring(0, 8) == "apprise ") {
                    ret = { "code": 0, "message": "sent to apprise" };
                    const { spawn } = require("child_process");
                    const appriseArgs = parseShellArgs(skey.substring(8));
                    const child = spawn('apprise', [...appriseArgs, '-t', title, '-b', desp]);
                    child.stdout.on('data', (data) => console.log('stdout: ' + data));
                    child.stderr.on('data', (data) => console.log('stderr: ' + data));
                    child.on('error', (error) => console.log('error: ' + error.message));
                }

                console.log("发送结果", ret);

                sendResults.push({ skey, result: ret });
            }

            return { success: true, sendResults };

        } else {
            console.log("没有新内容", task.title);
            return { success: false, message: "没有新内容" };
        }
    } catch (error) {
        // 捕获未预期的错误
        const errorType = classifyError(error);
        logError(task.title, errorType, error, task.feed);
        
        // 发送失败通知（通过所有 task.keys 通道）
        await sendFailureNotification(task, errorType, error, null);

        return { success: false, error: error.message, errorType };
    }
}

async function translate( markdown )
{
    const llm = new Api2d( process.env.OPENAI_KEY, process.env.OPENAI_API_BASE );
    const prompt = '\n# Task 请将Markdown清理掉样式和广告后翻译为中文\n\n# RULES\n\n1. 不要修改原始Markdown的格式，务必保留其中的图片、链接、视频等格式\n1. 去掉输入内容中多余的CSS和HTML标签\n1. 去掉原始内容中的广告和推广内容，比如购买会员、下载APP等\n1. 专有名词保留，无需翻译\n\n# INPUT\n\n```md    \n' + markdown + '\n```\n\n\n# OUTPUT\n\n翻译结果：';
    
    const ret = await llm.completion({
        model: 'gpt-3.5-turbo',
        messages:[
            {
                'role':'system',
                'content': '你是世界一流的翻译家，精通将各国语言翻译为中文。'
            },
            {
                'role':'user',
                'content': prompt
            },
        ],
        stream: true,
        onMessage: (string,char) => {
            process.stdout.write( char );
        },
    });
    console.log( "ret", ret );
    if( ret ) return {"result":ret};
    else return false;
}

async function sc_send( title, desp,short,  key )
{
    const url = String(key).startsWith('sctp') 
    ? 'https://' + key + '.push.ft07.com/send'
    : 'https://sctapi.ftqq.com/' + key + '.send';
    const form = new FormData();
    form.append( 'text',title );
    form.append( 'desp',desp );
    form.append( 'short',short );
    try {
        const response = await fetch( url, {
            method: 'POST', 
            body: form
        } );

        const ret = await response.json();
        return ret;
    } catch (error) {
        console.log( error );
        return false;
    } 
}

module.exports = {
    processTask,
    classifyError,
    ErrorType
};
