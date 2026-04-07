import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
async function run() {
  const response = await ai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    contents: [{ role: 'user', parts: [{ text: 'What is the weather in Paris?' }] }],
    config: {
      tools: [{ functionDeclarations: [{ name: 'getWeather', description: 'Get weather', parameters: { type: 'OBJECT', properties: { location: { type: 'STRING' } } } }] }]
    }
  });
  console.log(JSON.stringify(response.candidates?.[0]?.content, null, 2));
}
run().catch(console.error);
