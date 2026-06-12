'use client';

import { useState, useRef } from 'react';

interface VideoItem {
  name: string;
  url: string;
  status: boolean;
}

export default function Home() {
  const [url, setUrl] = useState('');
  const [type, setType] = useState<'playlist' | 'video'>('playlist');
  const [loading, setLoading] = useState(false);
  const [scrapeProgress, setScrapeProgress] = useState('');
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [downloadAllProgress, setDownloadAllProgress] = useState('');
  const [error, setError] = useState('');
  const [scrapedFile, setScrapedFile] = useState<string | null>(null);
  const [scrapedData, setScrapedData] = useState<VideoItem[]>([]);
  const scrapedFileRef = useRef<string | null>(null);

  const validateUrl = (input: string) => {
    if (!input) {
      setError('');
      return true;
    }
    // Stricter regex: must be a valid youtube domain, and if protocol exists, it must be http/https
    const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;
    const protocolCheck = input.includes('://') && !input.startsWith('http://') && !input.startsWith('https://');
    
    if (protocolCheck || !youtubeRegex.test(input)) {
      setError('Please enter a valid YouTube URL (e.g., https://youtube.com/...)');
      return false;
    }
    setError('');
    return true;
  };

  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setUrl(value);
    validateUrl(value);
  };

  const handleFetch = async () => {
    if (!validateUrl(url)) return;

    setLoading(true);
    setScrapeProgress('Opening browser...');
    setScrapedData([]);
    setScrapedFile(null);
    scrapedFileRef.current = null;
    setError('');

    try {
      const response = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, type }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Scraping failed' }));
        setError(err.error || 'Scraping failed');
        setLoading(false);
        return;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('ndjson')) {
        setError('Unexpected response format');
        setLoading(false);
        return;
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line) continue;

          if (line.startsWith('__DONE__:')) {
            const filename = line.slice('__DONE__:'.length).trim();
            setScrapedFile(filename);
            scrapedFileRef.current = filename;
            setScrapeProgress('Scraping complete!');
          } else if (line.startsWith('__ERROR__:')) {
            const msg = line.slice('__ERROR__:'.length);
            setError(msg);
          } else {
            try {
              const video = JSON.parse(line);
              setScrapedData(prev => [...prev, { name: video.name, url: video.url, status: false }]);
              setScrapeProgress(`Found ${video.name ? video.name.slice(0, 40) : 'video'}...`);
            } catch {}
          }
        }
      }
    } catch (err) {
      setError('Connection failed. Is the server running?');
      console.error(err);
    } finally {
      setLoading(false);
      setScrapeProgress('');
    }
  };

  const handleDownloadAll = async () => {
    const file = scrapedFileRef.current;
    if (!file) {
      setError('No scraped data to download');
      return;
    }

    setDownloadingAll(true);
    setDownloadAllProgress('Starting...');
    setError('');

    for (let i = 0; i < scrapedData.length; i++) {
      if (scrapedData[i].status) continue;

      setDownloadAllProgress(`Downloading ${i + 1}/${scrapedData.length}...`);

      try {
        const response = await fetch('/api/convert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoUrl: scrapedData[i].url,
            jsonFilename: file,
            videoIndex: i,
          }),
        });

        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || `Video ${i + 1} failed`);
        }

        const blob = await response.blob();
        const contentDisposition = response.headers.get('Content-Disposition');
        const cdMatch = contentDisposition?.match(/filename="?(.+?)"?$/);
        const fileName = cdMatch ? cdMatch[1] : `video_${i + 1}.mp3`;

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        setScrapedData(prev => {
          const next = [...prev];
          if (next[i]) {
            next[i] = { ...next[i], status: true };
          }
          return next;
        });
      } catch (err: any) {
        setError(err.message || `Video ${i + 1} failed`);
        break;
      }
    }

    setDownloadingAll(false);
    setDownloadAllProgress('');
  };

  const thStyle: React.CSSProperties = {
    padding: '12px 16px',
    textAlign: 'left',
    fontWeight: '700',
    color: '#888',
    fontSize: '12px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px'
  };

  const tdStyle: React.CSSProperties = {
    padding: '12px 16px',
    color: '#ccc',
    borderBottom: '1px solid rgba(255,255,255,0.04)'
  };

  return (
    <div style={{ 
      minHeight: '100vh', 
      backgroundColor: '#050505', 
      backgroundImage: 'radial-gradient(circle at 50% -20%, #1a1a1a 0%, #050505 100%)',
      display: 'flex', 
      justifyContent: 'center', 
      alignItems: scrapedData.length > 0 ? 'flex-start' : 'center',
      padding: '20px',
      fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      color: '#ffffff',
      position: 'relative',
      overflow: 'hidden',
      paddingTop: scrapedData.length > 0 ? '40px' : '20px'
    }}>
      {/* Fallback for animation if styled-jsx is problematic */}
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes rotate-bg {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .animate-rotate {
          animation: rotate-bg 10s linear infinite;
        }
      `}} />

      <main style={{ 
        width: '100%',
        maxWidth: scrapedData.length > 0 ? '900px' : '480px',
        backgroundColor: 'rgba(20, 20, 20, 0.8)',
        backdropFilter: 'blur(20px)',
        borderRadius: '32px',
        padding: '48px',
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5), inset 0 1px 1px rgba(255,255,255,0.05)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        position: 'relative',
        zIndex: 1,
        overflow: 'hidden'
      }}>
        {/* Animated Background Accent */}
        <div 
          className="animate-rotate"
          style={{
            position: 'absolute',
            top: '-50%',
            left: '-50%',
            width: '200%',
            height: '200%',
            background: 'conic-gradient(from 180deg at 50% 50%, transparent 0deg, #ff0033 360deg)',
            opacity: '0.03',
            zIndex: 0,
            pointerEvents: 'none'
          }} 
        />

        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ textAlign: 'center', marginBottom: '40px' }}>
            <div style={{ 
              width: '72px', 
              height: '72px', 
              background: 'linear-gradient(135deg, #ff0033 0%, #cc0022 100%)', 
              borderRadius: '20px', 
              display: 'flex', 
              justifyContent: 'center', 
              alignItems: 'center',
              margin: '0 auto 20px auto',
              boxShadow: '0 0 30px rgba(255, 0, 51, 0.3)',
              position: 'relative'
            }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="white">
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
              </svg>
            </div>
            <h1 style={{ 
              fontSize: '32px', 
              fontWeight: '900', 
              letterSpacing: '-1px',
              marginBottom: '10px',
              background: 'linear-gradient(to bottom, #ffffff, #888888)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent'
            }}>
              YouTube Scraper
            </h1>
            <p style={{ color: '#888', fontSize: '15px', fontWeight: '500' }}>
              Premium link extraction. Pure performance.
            </p>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
            <div>
              <input
                id="url"
                type="text"
                value={url}
                onChange={handleUrlChange}
                placeholder="Enter YouTube Link"
                style={{ 
                  width: '100%', 
                  padding: '20px 24px', 
                  fontSize: '16px',
                  fontWeight: '500',
                  borderRadius: '20px',
                  border: '1px solid rgba(255,255,255,0.1)',
                  outline: 'none',
                  backgroundColor: 'rgba(255,255,255,0.03)',
                  color: '#ffffff',
                  boxSizing: 'border-box',
                  transition: 'all 0.3s ease',
                  textAlign: 'center'
                }}
                onFocus={(e) => {
                  e.currentTarget.style.border = '1px solid rgba(255, 0, 51, 0.5)';
                  e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)';
                  e.currentTarget.style.boxShadow = '0 0 200px rgba(255, 0, 51, 0.05)';
                }}
                onBlur={(e) => {
                  e.currentTarget.style.border = '1px solid rgba(255,255,255,0.1)';
                  e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.03)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              />
            </div>

            <div style={{ 
              backgroundColor: 'rgba(255,255,255,0.02)', 
              padding: '8px', 
              borderRadius: '24px',
              display: 'flex',
              alignItems: 'center',
              border: '1px solid rgba(255,255,255,0.05)'
            }}>
              <button 
                onClick={() => setType('video')}
                style={{
                  flex: 1,
                  padding: '14px',
                  borderRadius: '18px',
                  border: 'none',
                  backgroundColor: type === 'video' ? 'rgba(255,255,255,0.08)' : 'transparent',
                  color: type === 'video' ? '#ffffff' : '#555',
                  fontSize: '14px',
                  fontWeight: '700',
                  cursor: 'pointer',
                  transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
                }}
              >
                Single Video
              </button>
              <button 
                onClick={() => setType('playlist')}
                style={{
                  flex: 1,
                  padding: '14px',
                  borderRadius: '18px',
                  border: 'none',
                  backgroundColor: type === 'playlist' ? 'rgba(255,255,255,0.08)' : 'transparent',
                  color: type === 'playlist' ? '#ffffff' : '#555',
                  fontSize: '14px',
                  fontWeight: '700',
                  cursor: 'pointer',
                  transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
                }}
              >
                Playlist
              </button>
            </div>

            <button
              onClick={handleFetch}
              disabled={loading || !url}
              style={{
                width: '100%',
                padding: '22px',
                fontSize: '16px',
                fontWeight: '800',
                background: loading || !url ? '#1a1a1a' : 'linear-gradient(to right, #ff0033, #cc0022)',
                color: loading || !url ? '#444' : 'white',
                border: 'none',
                borderRadius: '24px',
                cursor: loading || !url ? 'not-allowed' : 'pointer',
                transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                boxShadow: loading || !url ? 'none' : '0 15px 30px rgba(255, 0, 51, 0.25)',
                textTransform: 'uppercase',
                letterSpacing: '1px'
              }}
            >
              {loading ? (scrapeProgress || 'Processing...') : 'Engage Scraper'}
            </button>

            {scrapedData.length > 0 && (
              <button
                onClick={handleDownloadAll}
                disabled={downloadingAll}
                style={{
                  width: '100%',
                  padding: '18px',
                  fontSize: '15px',
                  fontWeight: '800',
                  background: downloadingAll ? '#1a1a1a' : 'linear-gradient(to right, #00cc44, #009933)',
                  color: downloadingAll ? '#444' : 'white',
                  border: 'none',
                  borderRadius: '24px',
                  cursor: downloadingAll ? 'not-allowed' : 'pointer',
                  transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                  boxShadow: downloadingAll ? 'none' : '0 15px 30px rgba(0, 204, 68, 0.25)',
                  textTransform: 'uppercase',
                  letterSpacing: '1px'
                }}
              >
                {downloadingAll ? downloadAllProgress : `Download All (${scrapedData.length})`}
              </button>
            )}

          </div>

          {scrapedData.length > 0 && (
            <div style={{ marginTop: '32px' }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '16px'
              }}>
                <h2 style={{
                  fontSize: '18px',
                  fontWeight: '700',
                  color: '#ffffff',
                  margin: 0
                }}>
                  Scraped Videos ({scrapedData.length})
                </h2>
                <span style={{
                  fontSize: '13px',
                  color: '#00ff64',
                  fontWeight: '600'
                }}>
                  ✓ {scrapedFile ? 'Scraped' : `${scrapedData.length} found`}
                </span>
              </div>
              <div style={{
                overflowX: 'auto',
                borderRadius: '16px',
                border: '1px solid rgba(255,255,255,0.06)'
              }}>
                <table style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: '13px'
                }}>
                  <thead>
                    <tr style={{
                      backgroundColor: 'rgba(255,255,255,0.03)',
                      borderBottom: '1px solid rgba(255,255,255,0.06)'
                    }}>
                      <th style={thStyle}>#</th>
                      <th style={thStyle}>Name</th>
                      <th style={thStyle}>URL</th>
                      <th style={thStyle}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scrapedData.map((item, i) => (
                      <tr key={i} style={{
                        borderBottom: '1px solid rgba(255,255,255,0.04)',
                        transition: 'background 0.2s'
                      }}>
                        <td style={tdStyle}>{i + 1}</td>
                        <td style={{ ...tdStyle, maxWidth: '250px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.name}>
                          {item.name}
                        </td>
                        <td style={{ ...tdStyle, maxWidth: '350px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.url}>
                          {item.url}
                        </td>
                        <td style={tdStyle}>
                          <span style={{
                            display: 'inline-block',
                            padding: '4px 12px',
                            borderRadius: '20px',
                            fontSize: '12px',
                            fontWeight: '600',
                            backgroundColor: item.status ? 'rgba(0, 255, 100, 0.1)' : 'rgba(255, 180, 0, 0.1)',
                            color: item.status ? '#00ff64' : '#ffb400'
                          }}>
                            {item.status ? 'Downloaded' : 'Fetched'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {error && (
            <div style={{ 
              marginTop: '32px', 
              padding: '18px', 
              backgroundColor: 'rgba(255, 0, 51, 0.05)', 
              borderRadius: '20px', 
              color: '#ff0033',
              fontSize: '14px',
              fontWeight: '600',
              border: '1px solid rgba(255, 0, 51, 0.1)',
              textAlign: 'center'
            }}>
              ✕ {error}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
