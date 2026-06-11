import { NextRequest, NextResponse } from 'next/server';
import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs-extra';

async function getChromePath() {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  for (const p of paths) {
    if (await fs.pathExists(p)) {
      return p;
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const { videoUrl, jsonFilename, videoIndex } = await req.json();

    if (!videoUrl) {
      return NextResponse.json({ error: 'Video URL is required' }, { status: 400 });
    }

    const executablePath = await getChromePath();
    if (!executablePath) {
      return NextResponse.json({ error: 'Chrome not found. Please install Google Chrome.' }, { status: 500 });
    }

    console.log('Launching browser...');
    const browser = await puppeteer.launch({
      executablePath,
      headless: false,
      defaultViewport: null,
      args: ['--start-maximized'],
    });

    const [page] = await browser.pages();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    // Inject hooks before page scripts run
    await page.evaluateOnNewDocument(() => {
      // Block ad popups
      window.open = () => null;

      // Capture download URL from API JSON responses
      const origFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        return origFetch(input, init).then(async (response) => {
          const ct = response.headers.get('content-type') || '';
          if (ct.includes('json')) {
            try {
              const clone = response.clone();
              const data = await clone.json();
              if (typeof data.downloadURL === 'string' && data.downloadURL.length > 0) {
                window.__downloadURL = data.downloadURL;
              }
            } catch {}
          }
          return response;
        });
      };
    });

    console.log('Navigating to yt2mp3.gs...');
    await page.goto('https://yt2mp3.gs', { waitUntil: 'networkidle0', timeout: 30000 });

    // Ensure MP3 format is selected
    console.log('Ensuring MP3 format...');
    const mp3Btn = await page.$('.form__formats button:first-child');
    if (mp3Btn) {
      const isActive = await page.evaluate(el => el.classList.contains('active'), mp3Btn);
      if (!isActive) await mp3Btn.click();
    }

    await page.waitForSelector('input#video', { timeout: 10000 });
    await page.type('input#video', videoUrl, { delay: 50 });

    console.log('Clicking Convert...');
    await page.click('button[type="submit"]');

    // Wait for conversion to complete and download section to appear
    console.log('Waiting for .form__download...');
    await page.waitForSelector('.form__download', { timeout: 300000 });

    await new Promise(r => setTimeout(r, 2000));

    // Retrieve captured download URL
    console.log('Checking for captured download URL...');
    let downloadUrl: string | null = null;

    for (let attempt = 0; attempt < 30; attempt++) {
      downloadUrl = await page.evaluate(() => window['__downloadURL'] || null);
      if (downloadUrl) {
        console.log('Got download URL from fetch hook on attempt', attempt + 1, ':', downloadUrl);
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!downloadUrl) {
      // Fallback: try to extract from the download button's click navigation
      console.log('Fetch hook did not capture URL, trying click-based capture...');
      let captured: string | null = null;

      page.on('request', (req) => {
        if (captured) return;
        const u = req.url();
        if (
          u.includes('epsiloncloud') || u.includes('iotacloud') ||
          (u !== page.url() && !u.startsWith('data:') && !u.includes('yt2mp3') && !u.includes('doubleclick') && !u.includes('google') && !u.includes('facebook'))
        ) {
          captured = u;
          console.log('Captured request URL:', u);
        }
      });

      const btn = await page.$('.form__download button.download, .form__download .download');
      if (btn) {
        await btn.click();
        console.log('Clicked download button');
        await new Promise(r => setTimeout(r, 15000));
      }

      if (!captured) {
        console.log('Retrying click on .form__download...');
        await page.click('.form__download');
        await new Promise(r => setTimeout(r, 10000));
      }

      downloadUrl = captured;
    }

    if (!downloadUrl) {
      // Last resort: read the download URL from the JSON via response interception
      console.log('Trying response interception...');
      downloadUrl = await page.evaluate(() => {
        const allScripts = Array.from(document.querySelectorAll('script'));
        for (const s of allScripts) {
          if (s.textContent?.includes('downloadURL')) {
            const match = s.textContent.match(/"downloadURL"\s*:\s*"([^"]+)"/);
            if (match) return match[1];
          }
        }
        return null;
      });
    }

    if (!downloadUrl) {
      throw new Error('Could not obtain download URL');
    }

    // Construct the full download URL with all params (same as yt2mp3.gs click handler)
    const fullDownloadUrl = await page.evaluate((baseUrl) => {
      const section = document.querySelector('.form__download');
      const videoId = section?.getAttribute('data-id') || '';
      const fmtBtn = document.querySelector('.form__formats button.active');
      const fmt = fmtBtn?.textContent?.trim().toLowerCase() || 'mp3';
      return baseUrl + '&v=' + videoId + '&f=' + fmt + '&r=' + window.location.hostname;
    }, downloadUrl);

    console.log('Full download URL:', fullDownloadUrl);

    const cookies = await page.cookies();
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    await browser.close();

    console.log('Fetching MP3 from full URL:', fullDownloadUrl);
    const resp = await fetch(fullDownloadUrl, {
      headers: {
        'Cookie': cookieString,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': 'https://yt2mp3.gs/',
        'Accept': '*/*',
      },
      redirect: 'follow',
    });

    console.log('Download response status:', resp.status);
    console.log('Download response headers:', Object.fromEntries(resp.headers.entries()));

    if (!resp.ok) throw new Error(`Download failed with status ${resp.status}`);

    const respContentType = resp.headers.get('content-type') || '';
    console.log('Response Content-Type:', respContentType);

    if (respContentType.includes('text/html') || respContentType.includes('text/plain')) {
      const text = await resp.text();
      console.log('Response is HTML/text, first 500 chars:', text.slice(0, 500));
      throw new Error('Download server returned HTML instead of audio file');
    }

    const arrayBuffer = await resp.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);
    console.log('Downloaded file size:', fileBuffer.length, 'bytes');

    if (fileBuffer.length < 100) {
      console.log('File too small. Content:', fileBuffer.toString('utf8'));
      throw new Error('Downloaded file is too small (likely an error page)');
    }

    if (fileBuffer.length > 2) {
      const magic = fileBuffer.slice(0, 3).toString('hex');
      const isValid = magic.startsWith('494433') || magic.startsWith('fff');
      console.log('File magic bytes:', magic, 'Valid MP3:', isValid);
      if (!isValid) {
        console.log('WARNING: Not MP3 data. First 200 bytes hex:', fileBuffer.slice(0, 200).toString('hex'));
        console.log('As text:', fileBuffer.slice(0, 200).toString('utf8'));
      }
    }

    const cd = resp.headers.get('content-disposition') || '';
    const match = cd.match(/filename="?(.+?)"?$/);
    const fileName = match ? match[1] : `video_${videoIndex + 1}.mp3`;

    // Use actual response content-type if it's audio/video, otherwise fallback
    const isAudioVideo = respContentType.startsWith('audio/') || respContentType.startsWith('video/');
    const contentType = isAudioVideo ? respContentType : 'audio/mpeg';

    if (jsonFilename) {
      const jsonPath = path.join(process.cwd(), 'data', jsonFilename);
      if (await fs.pathExists(jsonPath)) {
        const jsonData = JSON.parse(await fs.readFile(jsonPath, 'utf-8'));
        if (jsonData[videoIndex]) {
          jsonData[videoIndex].status = true;
        }
        await fs.writeJson(jsonPath, jsonData, { spaces: 2 });
      }
    }

    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'X-Updated-Index': String(videoIndex),
      },
    });
  } catch (error: any) {
    console.error('Conversion error:', error);
    return NextResponse.json({ error: error.message || 'Conversion failed' }, { status: 500 });
  }
}
