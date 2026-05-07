import express from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware
  app.use(express.json({ limit: '50mb' }));

  // API Routes
  app.post('/api/categorize', async (req, res) => {
    try {
      const { files, provider, apiKey, model, localUrl } = req.body;
      if (!files || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: 'No files provided.' });
      }

      const systemPromptForJson = `You are an intelligent file categorizer. Below is a list of filenames from a user's Google Drive/local computer. Group them into meaningful, cohesive category names based on their file extensions and naming patterns (e.g. "Screenshots", "USCIS Forms", "Job Applications", "Images", "Documents"). Create around 3 to 10 logical categories. Put files that don't fit well into a "Misc" or "Other" category.

IMPORTANT: Return ONLY a valid JSON object. Do NOT use markdown code blocks. The JSON must map exactly to this schema:
{
  "categories": [
    {
      "categoryName": "string",
      "files": ["exact_filename1.ext", "exact_filename2.ext"]
    }
  ]
}`;

      const systemPromptForText = `You are an intelligent file categorizer. Group the provided filenames into meaningful categories based on their extensions and naming patterns (e.g., "Screenshots", "Documents"). Create 3 to 10 logical categories. Put unknown files into "Misc".
      
IMPORTANT: Return ONLY plain text in the following exact format. Do NOT use markdown, code blocks, or JSON. Give the explicit category, and then the exact filenames underneath it.

CATEGORY: Screenshots
FILE: image1.png
FILE: image2.png

CATEGORY: Documents
FILE: doc1.pdf`;

      const userMessage = `Files:\n${files.join('\n')}`;

      let parsed: any;

      if (provider === 'openrouter' || provider === 'local') {
        let targetUrl = 'https://openrouter.ai/api/v1/chat/completions';
        if (provider === 'local') {
           const base = localUrl || 'http://localhost:1234/v1';
           targetUrl = base.endsWith('/chat/completions') ? base : (base.endsWith('/') ? base + 'chat/completions' : base + '/chat/completions');
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };

        if (provider === 'openrouter') {
          if (!apiKey) {
            return res.status(400).json({ error: 'OpenRouter API key is required when using OpenRouter.' });
          }
          headers['Authorization'] = `Bearer ${apiKey}`;
          headers['HTTP-Referer'] = process.env.APP_URL || 'http://localhost:3000';
          headers['X-Title'] = 'Smart Drive Organizer';
        } else if (apiKey) {
           headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const openrouterModel = model || (provider === 'openrouter' ? 'liquid/lfm-40b:free' : 'llama3');

        const response = await fetch(targetUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: openrouterModel,
            messages: [
              { role: 'system', content: systemPromptForText },
              { role: 'user', content: userMessage }
            ]
          })
        });

        if (!response.ok) {
           const errData = await response.text();
           throw new Error(`${provider === 'local' ? 'Local API' : 'OpenRouter API'} error (${response.status}): ${errData}`);
        }

        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content;
        
        if (!text) throw new Error('No text generated from AI API.');

        // Robust Plain Text Parser
        const lines = text.split('\n').map((l: string) => l.trim().replace(/^[`\*\-]+/, '').trim());
        const categoriesMap = new Map<string, string[]>();
        let currentCategory = "Misc";
        let foundFiles = 0;
        
        for (const line of lines) {
           if (!line) continue;
           let lineClean = line;
           if (lineClean.toUpperCase().startsWith('CATEGORY:')) {
              currentCategory = lineClean.substring(9).trim().replace(/[:\*_]/g, '');
              continue;
           }
           if (lineClean.toUpperCase().startsWith('FILE:')) {
              lineClean = lineClean.substring(5).trim();
           }
           const cleanFileName = lineClean.replace(/^[-\*\d\.\s]+/, ''); // remove bullet points
           
           // Simple proximity check: Does this filename look like one of the files we sent?
           const matchedFile = files.find((f: string) => cleanFileName === f || cleanFileName.includes(f) || f.includes(cleanFileName));
           
           if (matchedFile) {
               if (!categoriesMap.has(currentCategory)) categoriesMap.set(currentCategory, []);
               if (!categoriesMap.get(currentCategory)!.includes(matchedFile)) {
                  categoriesMap.get(currentCategory)!.push(matchedFile);
                  foundFiles++;
               }
           }
        }

        if (foundFiles === 0) {
            try {
              const cleanedText = text.replace(/^```(json)?\n?/, '').replace(/\n?```$/, '').trim();
              const parsedRaw = JSON.parse(cleanedText);
              if (parsedRaw.categories) parsed = parsedRaw.categories;
              else if (Array.isArray(parsedRaw)) parsed = parsedRaw;
              else throw new Error("Format mismatch");
            } catch (err: any) {
              console.error("Failed to parse output:", text);
              throw new Error('Failed to parse AI output. The AI did not format the files properly.');
            }
        } else {
            parsed = Array.from(categoriesMap.entries()).map(([k, v]) => ({ categoryName: k, files: v }));
        }

      } else {
        // Gemini
        const geminiKey = apiKey || process.env.GEMINI_API_KEY;
        if (!geminiKey) {
          return res.status(500).json({ error: 'GEMINI_API_KEY environment variable is missing.' });
        }

        const ai = new GoogleGenAI({ apiKey: geminiKey });
        
        const response = await ai.models.generateContent({
          model: model || 'gemini-3-flash-preview',
          contents: `${systemPromptForJson}\n\n${userMessage}`,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  categoryName: { type: Type.STRING, description: 'The logical name for the folder.' },
                  files: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'The exact filenames belonging to this category.' }
                },
                required: ['categoryName', 'files']
              }
            }
          }
        });

        const text = response.text;
        if (!text) throw new Error('No text generated from Gemini');
        
        try {
          parsed = JSON.parse(text);
          if (!Array.isArray(parsed) && parsed.categories) {
             parsed = parsed.categories;
          }
        } catch (err) {
          throw new Error('Failed to parse Gemini generated JSON. Response: ' + text);
        }
      }

      if (!Array.isArray(parsed)) {
        throw new Error('AI output was not categorized properly (Expected Array).');
      }

      res.json({ categories: parsed });
    } catch (error: any) {
      console.error('Categorize error:', error);
      let errorMessage = error.message || 'An error occurred during categorization.';
      if (errorMessage.includes('API_KEY_INVALID') || errorMessage.includes('API key not valid')) {
        errorMessage = 'Your Gemini API Key is invalid. Please clear it from the Secrets panel to use the built-in key or provide a valid one.';
      }
      res.status(500).json({ error: errorMessage });
    }
  });

  // Vite Integration for dev
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);
