/**
 * Parses WebVTT content and extracts clean text for AI processing
 * 
 * @param vttContent - Raw WebVTT content
 * @returns Clean transcript text without timestamps and markers
 */
export function extractTextFromVTT(vttContent: string): string {
  if (!vttContent.trim()) {
    return '';
  }

  const lines = vttContent.split('\n');
  const textLines: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Skip empty lines
    if (!line) continue;
    
    // Skip WEBVTT header
    if (line === 'WEBVTT') continue;
    
    // Skip NOTE lines
    if (line.startsWith('NOTE ')) continue;
    
    // Skip timestamp lines (contain -->)
    if (line.includes('-->')) continue;
    
    // Skip cue identifiers (numeric or UUID-like patterns)
    if (/^[\d\w-]+$/.test(line) && !line.includes(' ')) continue;
    
    // Skip style/formatting tags
    if (line.startsWith('STYLE') || line.startsWith('REGION')) continue;
    
    // This should be subtitle text
    // Remove any inline formatting tags like <c.color> or <b>
    const cleanLine = line.replace(/<[^>]*>/g, '').trim();
    
    if (cleanLine) {
      textLines.push(cleanLine);
    }
  }
  
  // Join all text lines with spaces and clean up multiple spaces
  return textLines.join(' ').replace(/\s+/g, ' ').trim();
}