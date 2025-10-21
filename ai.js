// ai.js — Google Gemini integration
const { GoogleGenerativeAI } = require('@google/generative-ai');

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Missing GOOGLE_API_KEY in .env');

const modelName = process.env.GOOGLE_MODEL;
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: modelName });

exports.generateReply = async ({ messages, userId }) => {
  try {
    const sysPrompt =
      process.env.SYSTEM_PROMPT ||
      'You are a chat assistant called ChatJPT on a website of the same name. You are just meant to be a normal large language model that can caht with the user and act as an assistant. ';

    const sys = messages.find(m => m.role === 'system')?.text || sysPrompt;

    const convo = messages
      .filter(m => m.role !== 'system')
      .map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.text}`)
      .join('\n');

    const prompt = `${sys}\n\n${convo}\nAssistant:`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    return { text, raw: result };
  } catch (err) {
    console.error('[Gemini AI Error]', err);
    return { text: '⚠️ Sorry, I had trouble talking to Gemini.' };
  }
};
