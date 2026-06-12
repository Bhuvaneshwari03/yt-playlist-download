import { NextRequest } from 'next/server';
import { spawn } from 'child_process';
import readline from 'readline';
import path from 'path';

export async function POST(req: NextRequest) {
  try {
    const { url, type } = await req.json();

    if (!url) {
      return new Response(JSON.stringify({ error: 'URL is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const scraperPath = path.join(process.cwd(), 'scraper', 'index.ts');

    const stream = new ReadableStream({
      async start(controller) {
        const child = spawn('npx', ['tsx', `"${scraperPath}"`, `"${url}"`, `"${type}"`], {
          shell: true,
          env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true' },
        });

        let stderr = '';
        child.stderr.on('data', (data) => {
          stderr += data.toString();
          console.error(`Scraper STDERR: ${data}`);
        });

        const lineReader = readline.createInterface({
          input: child.stdout,
          crlfDelay: Infinity,
        });

        for await (const line of lineReader) {
          if (line.startsWith('__VIDEO__:')) {
            const videoData = line.slice('__VIDEO__:'.length);
            controller.enqueue(new TextEncoder().encode(videoData + '\n'));
          } else if (line.startsWith('__FILE__:')) {
            const filename = line.slice('__FILE__:'.length).trim();
            controller.enqueue(new TextEncoder().encode('__DONE__:' + filename + '\n'));
          } else {
            console.log('Scraper:', line);
          }
        }

        const exitCode = await new Promise<number>((resolve) => {
          child.on('close', resolve);
        });

        if (exitCode !== 0) {
          controller.enqueue(new TextEncoder().encode('__ERROR__:' + (stderr || `Exit code ${exitCode}`) + '\n'));
        }

        controller.close();
      },
    });

    return new Response(stream, {
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
  } catch (error: any) {
    console.error('API Error:', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal Server Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
