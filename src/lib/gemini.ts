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
  image?: { data: string, mimeType: string };
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
          throw new Error("Todos os modelos de fallback estão indisponíveis ou esgotaram sua cota diária.");
        }
      } else {
        throw error;
      }
    }
  }
  throw new Error("Nenhum modelo disponível.");
}

export async function sendMessage(
  userText: string, 
  image: { data: string, mimeType: string } | null,
  selectedTemplate: string | null,
  history: any[],
  onUpdate: (msg: Message) => void
): Promise<{ history: any[], error?: string }> {
  
  let systemInstruction = `Você é um assistente especialista em Obsidian e criação de mundos (world-building).
Você tem acesso total ao vault do Obsidian do usuário.
O usuário pedirá para você criar ou modificar notas (personagens, locais, eventos, etc.).
Se o usuário enviar uma imagem, analise-a detalhadamente e use as informações visuais para ajudar na criação de mundo, descrições de personagens, locais, ou o que o usuário solicitar.

CRÍTICO SOBRE PROPRIEDADES (YAML FRONTMATTER):
Quando você criar links para outras notas dentro do frontmatter (properties) no topo do arquivo, você DEVE formatá-los corretamente para o Obsidian.
NUNCA use a sintaxe \`[[["Nome da Nota"]]]\`.
Para listas de links, use:
\`\`\`yaml
faccao:
  - "[[Nome da Nota]]"
\`\`\`
ou \`faccao: ["[[Nome da Nota]]"]\`
Para um único link, use: \`faccao: "[[Nome da Nota]]"\`

Aqui estão os templates disponíveis no vault:
<templates>
${Object.entries(vault.templates).map(([name, content]) => `  <template name="${name}">\n${content}\n  </template>`).join('\n')}
</templates>

Ao criar uma nota, SEMPRE use o template apropriado se houver um.
Se o usuário selecionar explicitamente um template, priorize-o para o assunto principal do pedido.
Se o pedido do usuário implicar na criação de entidades secundárias (ex: um personagem que participou de um evento específico), você deve proativamente criar notas para essas entidades secundárias também, usando seus respectivos templates, e linká-las usando wikilinks do Obsidian (ex: [[Nome do Evento]]).

O vault possui a seguinte estrutura de pastas para organização:
- 01_Personagens
- 02_Locais
- 03_Organizações
- 04_Eventos

Sempre coloque as novas notas na pasta correta baseada no seu tipo.

Aqui está a lista atual de arquivos no vault:
${vault.files.join('\n')}
`;

  let prompt = userText;
  if (selectedTemplate) {
    prompt = `[O usuário selecionou o template principal: ${selectedTemplate}]\n\n${userText}`;
  }

  const currentHistory = [...history];
  const userParts: any[] = [];
  
  if (prompt.trim()) {
    userParts.push({ text: prompt });
  }
  
  if (image) {
    userParts.push({
      inlineData: {
        data: image.data,
        mimeType: image.mimeType
      }
    });
  }

  currentHistory.push({ role: 'user', parts: userParts });
  onUpdate({ role: 'user', text: userText, image: image || undefined });

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
          
          currentModelMessage.text += `\n\n*Nota criada/atualizada: \`${path}\`*`;
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
          
          currentModelMessage.text += `\n\n*Nota lida: \`${path}\`*`;
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
    onUpdate({ role: 'model', text: `Desculpe, ocorreu um erro ao processar seu pedido:\n\n\`\`\`\n${errorMessage}\n\`\`\`` });
    return { history: currentHistory, error: errorMessage };
  }
}
