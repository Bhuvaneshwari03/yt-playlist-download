import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import fs from 'fs-extra';
import path from 'path';

export async function POST(req: NextRequest) {
  try {
    const { url, type } = await req.json();

    if (!url) {
      return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    const scraperPath = path.join(process.cwd(), 'scraper', 'index.ts');

    return new Promise<NextResponse>((resolve) => {
      // Use npx tsx to run the typescript scraper script
      // Wrap arguments in quotes to handle special characters like & in URLs
      const child = spawn('npx', ['tsx', `"${scraperPath}"`, `"${url}"`, `"${type}"`], {
        shell: true,
        env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true' }
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
        console.log(`Scraper STDOUT: ${data}`);
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
        console.error(`Scraper STDERR: ${data}`);
      });

      child.on('close', async (code) => {
        console.log(`Scraper process exited with code ${code}`);
        if (code === 0) {
          const fileMatch = stdout.match(/__FILE__:(.+)/);
          const filename = fileMatch ? fileMatch[1].trim() : null;
          let data: { name: string; url: string; status: boolean }[] = [];
          if (filename) {
            const filePath = path.join(process.cwd(), 'data', filename);
            try {
              const fileContent = await fs.readFile(filePath, 'utf-8');
              data = JSON.parse(fileContent);
            } catch (e) {
              console.error('Failed to read scraped data:', e);
            }
          }
          resolve(NextResponse.json({ 
            message: 'Scraping completed successfully', 
            filename,
            data,
            output: stdout 
          }));
        } else {
          console.error(`Scraper failed. Code: ${code}, Stderr: ${stderr}`);
          resolve(NextResponse.json({ 
            error: 'Scraping failed', 
            details: stderr || 'Check server logs for details',
            exitCode: code 
          }, { status: 500 }));
        }
      });
    });

  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
