/**
 * 日志解析模块
 *
 * 负责：
 * - 解析 Claude 日志格式（位于 ~/.claude/projects 目录下）
 * - 解析 Codex 日志格式（位于 ~/.codex/sessions 目录下）
 * - 提取 Token 使用数据
 *
 * @module store/logParser
 */

/**
 * 解析 Claude 日志行
 * Claude 日志格式：包含 message.usage 字段
 * @param {string} line - JSONL 行
 * @returns {object|null} 解析后的记录 {timestamp, model, messageId, input, output, cacheRead, cacheCreate}
 */
export function parseClaudeLog(line) {
  try {
    const data = JSON.parse(line);

    // 检查是否有 usage 字段（在 message 对象内）
    if (!data.message?.usage) {
      return null;
    }

    const usage = data.message.usage;
    const timestamp = data.timestamp || data.message.timestamp;

    // 提取模型名称
    let model = data.message.model || 'unknown';

    // 标准化模型名称（移除版本号后缀，统一为系列名称）
    model = normalizeModelName(model);
    const messageId = typeof data.message.id === 'string' ? data.message.id : null;

    return {
      timestamp: timestamp ? new Date(timestamp) : null,
      model,
      messageId,
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || usage.cache_read_tokens || 0,
      cacheCreate: usage.cache_creation_input_tokens || usage.cache_creation_tokens || 0,
    };
  } catch (error) {
    // 静默处理解析失败
    return null;
  }
}

/**
 * 解析 Codex 日志行
 * Codex 日志格式：包含 type=event_msg, payload.type=token_count
 * @param {string} line - JSONL 行
 * @returns {object|null} 解析后的记录 {timestamp, model, input, output, cacheRead, cacheCreate}
 */
export function parseCodexLog(line) {
  try {
    const data = JSON.parse(line);

    // 只处理 token_count 类型的事件
    if (data.type !== 'event_msg' || data.payload?.type !== 'token_count') {
      return null;
    }

    // 提取 token 使用数据
    const info = data.payload.info;
    if (!info) {
      return null;
    }

    // Codex 使用 last_token_usage 表示单次请求
    const usage = info.last_token_usage || info.total_token_usage;
    if (!usage) {
      return null;
    }

    const timestamp = data.timestamp;

    // Codex 通常使用 openai 模型，但需要根据日志中的 model_provider 推断
    // 默认标记为 codex，后续可根据 provider 细化
    let model = 'codex';

    return {
      timestamp: timestamp ? new Date(timestamp) : null,
      model,
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheRead: usage.cached_input_tokens || 0,
      cacheCreate: 0, // Codex 日志中未明确区分 cache_create
    };
  } catch (error) {
    // 静默处理解析失败
    return null;
  }
}

/**
 * 解析 Codex token_count 的累计快照
 * @param {string} line - JSONL 行
 * @returns {object|null} 解析后的累计快照 {timestamp, model, inputTotal, outputTotal, cacheReadTotal, totalTokens}
 */
export function parseCodexTokenSnapshot(line) {
  try {
    const data = JSON.parse(line);

    // 只处理 token_count 类型的事件
    if (data.type !== 'event_msg' || data.payload?.type !== 'token_count') {
      return null;
    }

    const info = data.payload.info;
    if (!info?.total_token_usage) {
      return null;
    }

    const totalUsage = info.total_token_usage;
    const inputTotal = toSafeInt(totalUsage.input_tokens);
    const outputTotal = toSafeInt(totalUsage.output_tokens);
    const cacheReadTotal = toSafeInt(totalUsage.cached_input_tokens);
    const totalTokens = toSafeInt(totalUsage.total_tokens) || (inputTotal + outputTotal + cacheReadTotal);

    return {
      timestamp: data.timestamp ? new Date(data.timestamp) : null,
      model: 'codex',
      inputTotal,
      outputTotal,
      cacheReadTotal,
      totalTokens
    };
  } catch (error) {
    // 静默处理解析失败
    return null;
  }
}

/**
 * 标准化模型名称
 * 将完整模型名称转换为系列名称（如 claude-sonnet-4-5-20250929 -> sonnet）
 * @param {string} model - 原始模型名称
 * @returns {string} 标准化后的模型名称
 */
function normalizeModelName(model) {
  if (!model || typeof model !== 'string') {
    return 'unknown';
  }

  const lowerModel = model.toLowerCase();

  // Claude 模型系列
  if (lowerModel.includes('claude-opus') || lowerModel.includes('opus')) {
    return 'opus';
  }
  if (lowerModel.includes('claude-sonnet') || lowerModel.includes('sonnet')) {
    return 'sonnet';
  }
  if (lowerModel.includes('claude-haiku') || lowerModel.includes('haiku')) {
    return 'haiku';
  }
  if (lowerModel.includes('claude')) {
    return 'claude';
  }

  // GPT 模型系列
  if (lowerModel.includes('gpt-5') || lowerModel.includes('gpt5')) {
    return 'gpt-5';
  }
  if (lowerModel.includes('gpt-4o')) {
    return 'gpt-4o';
  }
  if (lowerModel.includes('gpt-4')) {
    return 'gpt-4';
  }
  if (lowerModel.includes('gpt-3.5') || lowerModel.includes('gpt3')) {
    return 'gpt-3.5';
  }

  // 其他模型
  if (lowerModel.includes('kimi')) {
    return 'kimi';
  }
  if (lowerModel.includes('deepseek')) {
    return 'deepseek';
  }
  if (lowerModel.includes('gemini')) {
    return 'gemini';
  }
  if (lowerModel.includes('qwen')) {
    return 'qwen';
  }
  if (lowerModel.includes('yi')) {
    return 'yi';
  }
  if (lowerModel.includes('llama')) {
    return 'llama';
  }
  if (lowerModel.includes('mistral')) {
    return 'mistral';
  }

  // 返回原始名称（去除版本号）
  return lowerModel.split(':')[0].split('-').slice(0, 2).join('-');
}

/**
 * 计算总 Token 数
 * 公式：总 Token = 输入 + 输出 + cache_read + cache_create
 * @param {object} record - 解析后的记录
 * @returns {number} 总 Token 数
 */
export function calculateTotalTokens(record) {
  return record.input + record.output + record.cacheRead + record.cacheCreate;
}

/**
 * 判断记录是否在时间窗口内
 * @param {object} record - 解析后的记录
 * @param {Date} start - 开始时间
 * @param {Date} end - 结束时间
 * @returns {boolean} 是否在窗口内
 */
export function isInTimeWindow(record, start, end) {
  if (!record.timestamp || !(record.timestamp instanceof Date)) {
    return false;
  }
  return record.timestamp >= start && record.timestamp <= end;
}

/**
 * 安全转换为整数
 * @param {unknown} value - 任意输入
 * @returns {number} 整数，非法值返回 0
 */
function toSafeInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.floor(parsed));
}
