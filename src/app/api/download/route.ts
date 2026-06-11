import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs-extra';
import path from 'path';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const filename = searchParams.get('file');

    if (!filename) {
      return NextResponse.json({ error: 'File parameter is required' }, { status: 400 });
    }

    const filePath = path.join(process.cwd(), 'data', filename);

    if (!(await fs.pathExists(filePath))) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const fileBuffer = await fs.readFile(filePath);
    const jsonData = JSON.parse(fileBuffer.toString());

    return new NextResponse(JSON.stringify(jsonData, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error('Download error:', error);
    return NextResponse.json({ error: 'Download failed' }, { status: 500 });
  }
}
