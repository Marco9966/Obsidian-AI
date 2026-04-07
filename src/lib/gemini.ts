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

const createFolderDeclaration = {
  name: "createFolder",
  description: "Create a new folder (directory) in the Obsidian vault to organize notes.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: "The folder path relative to the vault root, e.g., '01_Personagens/NPCs'"
      }
    },
    required: ["path"]
  }
};

const moveFileDeclaration = {
  name: "moveFile",
  description: "Move or rename a file in the Obsidian vault.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      oldPath: { type: Type.STRING, description: "The current file path, e.g., '01_Personagens/John.md'" },
      newPath: { type: Type.STRING, description: "The new file path, e.g., '01_Personagens/NPCs/John Doe.md'" }
    },
    required: ["oldPath", "newPath"]
  }
};

const deleteFilesDeclaration = {
  name: "deleteFiles",
  description: "Request to delete one or more files from the Obsidian vault. The user will be prompted to confirm the deletion.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      paths: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "An array of file paths to delete"
      }
    },
    required: ["paths"]
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
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
];

async function generateWithFallback(
  contents: any[], 
  config: any, 
  onUpdate?: (msg: Message) => void, 
  currentModelMessage?: Message,
  signal?: AbortSignal
) {
  let retryCount = 0;
  const MAX_RETRIES = 3;

  while (true) {
    if (signal?.aborted) {
      throw new Error("AbortError");
    }

    try {
      const generatePromise = ai.models.generateContent({
        model: MODELS[currentModelIndex],
        contents,
        config
      });

      const abortPromise = new Promise((_, reject) => {
        if (signal?.aborted) {
          reject(new Error("AbortError"));
        }
        signal?.addEventListener('abort', () => reject(new Error("AbortError")));
      });

      const response = await Promise.race([generatePromise, abortPromise]) as any;
      return response;
    } catch (error: any) {
      if (signal?.aborted) {
        throw new Error("AbortError");
      }

      const msg = error?.message?.toLowerCase() || String(error).toLowerCase();
      
      // Handle Rate Limits (429) by waiting
      if (msg.includes('429') && !msg.includes('quota')) {
        if (retryCount < MAX_RETRIES) {
          retryCount++;
          const waitTime = 30; // seconds
          if (onUpdate && currentModelMessage) {
            currentModelMessage.text += `\n\n*Atingimos o limite de requisições por minuto. Aguardando ${waitTime} segundos para continuar (Tentativa ${retryCount}/${MAX_RETRIES})...*`;
            onUpdate({ ...currentModelMessage });
          }
          await new Promise(resolve => {
            const timeout = setTimeout(resolve, waitTime * 1000);
            if (signal) {
              signal.addEventListener('abort', () => {
                clearTimeout(timeout);
                resolve(null);
              });
            }
          });
          if (signal?.aborted) throw new Error("AbortError");
          continue; // Retry with the same model
        }
      }

      if (
        msg.includes('quota') || 
        msg.includes('exhausted') || 
        msg.includes('limit') ||
        msg.includes('503') ||
        msg.includes('unavailable') ||
        msg.includes('high demand') ||
        msg.includes('429') // If it's a 429 and we exhausted retries, move to next model
      ) {
        console.warn(`Model ${MODELS[currentModelIndex]} hit quota limit or is unavailable. Switching to next model.`);
        currentModelIndex++;
        retryCount = 0; // Reset retries for the new model
        if (currentModelIndex >= MODELS.length) {
          currentModelIndex = 0;
          const waitTime = 60; // Wait 1 minute before restarting the cycle
          if (onUpdate && currentModelMessage) {
            currentModelMessage.text += `\n\n*Todos os modelos estão ocupados ou atingiram o limite. Não estamos conseguindo executar no momento e vai demorar um pouco mais. Aguardando ${waitTime} segundos para tentar novamente...*`;
            onUpdate({ ...currentModelMessage });
          }
          await new Promise(resolve => {
            const timeout = setTimeout(resolve, waitTime * 1000);
            if (signal) {
              signal.addEventListener('abort', () => {
                clearTimeout(timeout);
                resolve(null);
              });
            }
          });
          if (signal?.aborted) throw new Error("AbortError");
        }
      } else {
        throw error;
      }
    }
  }
}

export async function sendMessage(
  userText: string, 
  image: { data: string, mimeType: string } | null,
  selectedTemplate: string | null,
  history: any[],
  onUpdate: (msg: Message) => void,
  onRequestDelete: (paths: string[]) => Promise<string[]>,
  signal?: AbortSignal
): Promise<{ history: any[], error?: string }> {
  
  let systemInstruction = `Você é um assistente especialista em Obsidian e criação de mundos (world-building).
Você tem acesso total ao vault do Obsidian do usuário.
O usuário pedirá para você criar ou modificar notas (personagens, locais, eventos, etc.).
Se o usuário enviar uma imagem, analise-a detalhadamente e use as informações visuais para ajudar na criação de mundo, descrições de personagens, locais, ou o que o usuário solicitar.

CRÍTICO SOBRE TAREFAS LONGAS (MÚLTIPLAS NOTAS):
Se o usuário pedir para criar ou modificar muitas notas (ex: 5, 10 ou mais), você DEVE processar todas elas.
Para evitar limites de tamanho de resposta e garantir que tudo seja feito:
1. Planeje todas as notas que precisam ser criadas/modificadas.
2. Chame a ferramenta \`writeNote\` para um lote de notas (ex: 2 a 4 notas por vez).
3. Após receber o resultado de sucesso dessas chamadas (o sistema enviará automaticamente), na sua resposta seguinte, chame \`writeNote\` para o próximo lote.
4. Repita esse ciclo (chamada de ferramenta -> resposta do sistema -> chamada de ferramenta) até que TODAS as notas solicitadas tenham sido concluídas.
5. Apenas diga que terminou e encerre as chamadas de ferramenta quando a última nota tiver sido criada. Mantenha o contexto do pedido inicial até o fim.

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

CRÍTICO SOBRE TIMELINES (PLUGIN GEORGE BUTCO):
O usuário possui o plugin "Timeline" do George Butco instalado. Quando o usuário pedir para criar uma timeline ou eventos históricos, use a sintaxe deste plugin:
1. Para criar a visualização da timeline em uma nota, use um bloco de código especificando a tag que agrupa os eventos:
\`\`\`timeline
nome-da-tag
\`\`\`
2. Nas notas que representam os eventos (que devem conter a tag \`#nome-da-tag\`), adicione os dados do evento usando a seguinte tag HTML:
<span class='ob-timelines' data-date='YYYY-MM-DD-HH' data-title='Título do Evento' data-class='orange'>Descrição do evento.</span>
- O formato de \`data-date\` é estritamente \`YYYY-MM-DD-HH\` (Ano-Mês-Dia-Hora). Use \`00\` para valores desconhecidos (ex: \`1500-00-00-00\`). Para anos antes de Cristo, use um sinal de menos (ex: \`-0500-00-00-00\`).
- \`data-class\` define a cor (ex: red, orange, green, blue, purple).
- Para eventos com duração, adicione \`data-type='range'\` e \`data-end='YYYY-MM-DD-HH'\`.
- Você pode adicionar \`data-img='URL'\` para imagens.

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

Você pode criar novas pastas para organizar melhor as notas usando a ferramenta \`createFolder\`.
Você pode mover ou renomear arquivos usando a ferramenta \`moveFile\`.
Você pode deletar arquivos usando a ferramenta \`deleteFiles\` (o usuário precisará confirmar a exclusão).
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
      tools: [{ functionDeclarations: [writeNoteDeclaration, readNoteDeclaration, createFolderDeclaration, moveFileDeclaration, deleteFilesDeclaration] }],
      temperature: 0.7,
    }, onUpdate, { role: 'model', text: '' }, signal);

    let modelResponseText = response.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || '';
    let currentModelMessage: Message = { role: 'model', text: modelResponseText };
    onUpdate(currentModelMessage);

    if (response.candidates && response.candidates.length > 0 && response.candidates[0].content) {
      currentHistory.push(response.candidates[0].content);
    }

    while (response.functionCalls && response.functionCalls.length > 0) {
      if (signal?.aborted) {
        throw new Error("AbortError");
      }

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
        } else if (call.name === 'createFolder') {
          const path = call.args.path as string;
          const success = await vault.createFolder(path);
          
          currentModelMessage.text += `\n\n*Pasta criada: \`${path}\`*`;
          onUpdate({ ...currentModelMessage });

          functionResponses.push({
            functionResponse: {
              name: call.name,
              response: { result: success ? "Success" : "Failed to create folder" }
            }
          });
        } else if (call.name === 'moveFile') {
          const oldPath = call.args.oldPath as string;
          const newPath = call.args.newPath as string;
          const success = await vault.moveFile(oldPath, newPath);
          
          currentModelMessage.text += `\n\n*Arquivo movido: \`${oldPath}\` -> \`${newPath}\`*`;
          onUpdate({ ...currentModelMessage });

          functionResponses.push({
            functionResponse: {
              name: call.name,
              response: { result: success ? "Success" : "Failed to move file" }
            }
          });
        } else if (call.name === 'deleteFiles') {
          const paths = call.args.paths as string[];
          const approvedPaths = await onRequestDelete(paths);
          
          const results: Record<string, string> = {};
          for (const path of paths) {
            if (approvedPaths.includes(path)) {
              const success = await vault.deleteFile(path);
              results[path] = success ? "Deleted" : "Failed to delete";
              if (success) {
                currentModelMessage.text += `\n\n*Arquivo deletado: \`${path}\`*`;
              }
            } else {
              results[path] = "User denied deletion";
            }
          }
          
          onUpdate({ ...currentModelMessage });

          functionResponses.push({
            functionResponse: {
              name: call.name,
              response: { results }
            }
          });
        }
      }

      currentHistory.push({ role: 'user', parts: functionResponses });

      response = await generateWithFallback(currentHistory, {
        systemInstruction,
        tools: [{ functionDeclarations: [writeNoteDeclaration, readNoteDeclaration, createFolderDeclaration, moveFileDeclaration, deleteFilesDeclaration] }],
        temperature: 0.7,
      }, onUpdate, currentModelMessage, signal);

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
    if (error.message === "AbortError") {
      currentModelMessage.text += `\n\n*[Geração cancelada pelo usuário]*`;
      onUpdate({ ...currentModelMessage });
      return { history: currentHistory, error: "Geração cancelada pelo usuário." };
    }
    console.error("Error generating content:", error);
    const errorMessage = error?.message || String(error);
    onUpdate({ role: 'model', text: `Desculpe, ocorreu um erro ao processar seu pedido:\n\n\`\`\`\n${errorMessage}\n\`\`\`` });
    return { history: currentHistory, error: errorMessage };
  }
}
