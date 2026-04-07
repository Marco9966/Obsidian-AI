import { GoogleGenAI, Type } from '@google/genai';
import { vault } from './obsidian';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const writeNoteDeclaration = {
  name: "writeNote",
  description: "Create or update a markdown note in the Obsidian vault. Use this to save characters, events, locations, etc.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: "The file path relative to the vault root, e.g., '01_Personagens/John Doe.md'"
      },
      content: {
        type: Type.STRING,
        description: "The full markdown content of the note. If using a template, ensure the template variables are filled out."
      }
    },
    required: ["path", "content"]
  }
};

const readNoteDeclaration = {
  name: "readNote",
  description: "Read the content of an existing markdown note in the Obsidian vault.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: "The file path relative to the vault root, e.g., '01_Personagens/John Doe.md'"
      }
    },
    required: ["path"]
  }
};

export type Message = {
  role: 'user' | 'model';
  text: string;
};

export type ChatSession = {
  id: string;
  title: string;
  messages: Message[];
  history: any[];
};

let currentModelIndex = 0;
const MODELS = [
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
  'gemini-3-flash-live-preview'
];

async function generateWithFallback(contents: any[], config: any) {
  while (currentModelIndex < MODELS.length) {
    try {
      const response = await ai.models.generateContent({
        model: MODELS[currentModelIndex],
        contents,
        config
      });
      return response;
    } catch (error: any) {
      const msg = error?.message?.toLowerCase() || String(error).toLowerCase();
      if (
        msg.includes('429') || 
        msg.includes('quota') || 
        msg.includes('exhausted') || 
        msg.includes('limit') ||
        msg.includes('503') ||
        msg.includes('unavailable') ||
        msg.includes('high demand')
      ) {
        console.warn(`Model ${MODELS[currentModelIndex]} hit quota limit or is unavailable. Switching to next model.`);
        currentModelIndex++;
        if (currentModelIndex >= MODELS.length) {
          throw new Error("All fallback models are currently unavailable or have exhausted their quota.");
        }
      } else {
        throw error;
      }
    }
  }
  throw new Error("No models available.");
}

export async function sendMessage(
  userText: string, 
  selectedTemplate: string | null,
  history: any[],
  onUpdate: (msg: Message) => void
): Promise<{ history: any[], error?: string }> {
  
  let systemInstruction = `You are an expert Obsidian vault manager and world-building assistant.
You have full access to the user's Obsidian vault.
The user will ask you to create or modify notes (characters, locations, events, etc.).

Here are the available templates in the vault:
<templates>
${Object.entries(vault.templates).map(([name, content]) => `  <template name="${name}">\n${content}\n  </template>`).join('\n')}
</templates>

When creating a note, ALWAYS use the appropriate template if one exists.
If the user explicitly selects a template, prioritize that for the main subject of their request.
If the user's request implies the creation of secondary entities (e.g., they describe a character who participated in a specific event), you should proactively create notes for those secondary entities as well, using their respective templates, and link them together using Obsidian wikilinks (e.g., [[Event Name]]).

The vault has the following folder structure for organization:
- 01_Personagens
- 02_Locais
- 03_Organizações
- 04_Eventos

Always place new notes in the correct folder based on their type.

Here is the current list of files in the vault:
${vault.files.join('\n')}
`;

  let prompt = userText;
  if (selectedTemplate) {
    prompt = `[User selected primary template: ${selectedTemplate}]\n\n${userText}`;
  }

  const currentHistory = [...history];
  currentHistory.push({ role: 'user', parts: [{ text: prompt }] });
  onUpdate({ role: 'user', text: userText });

  try {
    let response = await generateWithFallback(currentHistory, {
      systemInstruction,
      tools: [{ functionDeclarations: [writeNoteDeclaration, readNoteDeclaration] }],
      temperature: 0.7,
    });

    let modelResponseText = response.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || '';
    let currentModelMessage: Message = { role: 'model', text: modelResponseText };
    onUpdate(currentModelMessage);

    if (response.candidates && response.candidates.length > 0 && response.candidates[0].content) {
      currentHistory.push(response.candidates[0].content);
    }

    while (response.functionCalls && response.functionCalls.length > 0) {
      const functionResponses = [];
      for (const call of response.functionCalls) {
        if (call.name === 'writeNote') {
          const path = call.args.path as string;
          const content = call.args.content as string;
          const success = await vault.writeFile(path, content);
          
          currentModelMessage.text += `\n\n*Created/Updated note: \`${path}\`*`;
          onUpdate({ ...currentModelMessage });

          functionResponses.push({
            functionResponse: {
              name: call.name,
              response: { result: success ? "Success" : "Failed to write file" }
            }
          });
        } else if (call.name === 'readNote') {
          const path = call.args.path as string;
          const content = await vault.readFile(path);
          
          currentModelMessage.text += `\n\n*Read note: \`${path}\`*`;
          onUpdate({ ...currentModelMessage });

          functionResponses.push({
            functionResponse: {
              name: call.name,
              response: { content: content !== null ? content : "File not found" }
            }
          });
        }
      }

      currentHistory.push({ role: 'user', parts: functionResponses });

      response = await generateWithFallback(currentHistory, {
        systemInstruction,
        tools: [{ functionDeclarations: [writeNoteDeclaration, readNoteDeclaration] }],
        temperature: 0.7,
      });

      const newText = response.candidates?.[0]?.content?.parts?.find(p => p.text)?.text;
      if (newText) {
        currentModelMessage.text += `\n\n${newText}`;
        onUpdate({ ...currentModelMessage });
      }
      
      if (response.candidates && response.candidates.length > 0 && response.candidates[0].content) {
        currentHistory.push(response.candidates[0].content);
      }
    }
    
    return { history: currentHistory };
  } catch (error: any) {
    console.error("Error generating content:", error);
    const errorMessage = error?.message || String(error);
    onUpdate({ role: 'model', text: `Sorry, an error occurred while processing your request:\n\n\`\`\`\n${errorMessage}\n\`\`\`` });
    return { history: currentHistory, error: errorMessage };
  }
}
