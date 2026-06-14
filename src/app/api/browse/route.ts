import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function POST() {
  console.log('Browse API: Starting folder picker...');
  try {
    // Basic but effective PowerShell script for folder selection
    const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select Folder'; if($f.ShowDialog() -eq 'OK'){ Write-Host $f.SelectedPath }"`;

    const { stdout, stderr } = await execAsync(command, { timeout: 30000 });
    
    if (stderr) {
      console.error('Browse API PowerShell Stderr:', stderr);
    }

    const selectedPath = stdout.trim();
    console.log('Browse API: Selection result ->', selectedPath || 'Cancelled');

    if (!selectedPath) {
      return NextResponse.json({ cancelled: true });
    }

    return NextResponse.json({ path: selectedPath });
  } catch (error: any) {
    console.error('Browse API Error:', error);
    return NextResponse.json({ 
      error: 'Failed to open folder picker',
      details: error.message 
    }, { status: 500 });
  }
}
