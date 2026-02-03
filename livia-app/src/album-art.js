/**
 * Album Art and Metadata Fetcher
 * Uses Gemini AI for ALL metadata (album info, artist bio, descriptions)
 * Uses multiple sources for album artwork with smart fallbacks
 */

const fetch = require('node-fetch');

// Gemini 2.5 Flash API
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

class AlbumArtFetcher {
  constructor(lastFmApiKey, geminiApiKey = null) {
    this.lastFmApiKey = lastFmApiKey;
    this.geminiApiKey = geminiApiKey;
    this.cache = new Map();
    this.metadataCache = new Map();
    this.maxCacheSize = 100;
  }

  /**
   * Get album info including artwork
   * @param {string} song - Song title
   * @param {string} artist - Artist name
   * @param {string} album - Album name (optional)
   * @param {string} thumbnailBase64 - Base64 thumbnail from SMTC (optional)
   */
  async getAlbumInfo(song, artist, album = null, thumbnailBase64 = null) {
    // Pre-process: Some apps (like Apple Music) combine artist and album in the artist field
    // e.g., "Travis Scott - JACKBOYS 2" should be split into artist="Travis Scott" album="JACKBOYS 2"
    if (artist && !album) {
      const separators = [' - ', ' — ', ' – '];
      for (const sep of separators) {
        if (artist.includes(sep)) {
          const parts = artist.split(sep);
          if (parts.length >= 2) {
            artist = parts[0].trim();
            album = parts.slice(1).join(sep).trim();
            console.log(`🔧 Split artist/album: "${artist}" / "${album}"`);
            break;
          }
        }
      }
    }
    
    console.log(`🎵 Input: song="${song}" artist="${artist}" album="${album}" thumbnail=${thumbnailBase64 ? `${Math.round(thumbnailBase64.length/1024)}KB` : 'no'}`);

    const cacheKey = `${song?.toLowerCase()}-${artist?.toLowerCase()}`;
    if (this.cache.has(cacheKey)) {
      console.log('📦 Using cached album info');
      return this.cache.get(cacheKey);
    }

    let result = {
      artUrl: null,
      albumName: album || null,
      genre: null,
      year: null,
      trackCount: null,
      label: null,
      albumDescription: null,
      artistBio: null,
      cleanedSong: song,
      cleanedArtist: artist,
      cleanedAlbum: album
    };

    // STEP 1: Get ALL metadata from Gemini AI
    if (this.geminiApiKey) {
      try {
        console.log('🤖 Fetching metadata from Gemini...');
        const aiMetadata = await this.fetchMetadataFromAI(song, artist, album);
        if (aiMetadata) {
          result = { ...result, ...aiMetadata };
          if (album) {
            result.albumName = album;
            result.cleanedAlbum = album;
          }
          console.log(`🤖 Gemini: "${result.cleanedSong}" by ${result.cleanedArtist}`);
          console.log(`   Album: "${result.albumName}" (${result.year || '?'})`);
          console.log(`   Genre: ${result.genre || '?'}, Label: ${result.label || '?'}`);
        }
      } catch (error) {
        console.log('🤖 Gemini failed:', error.message);
        const parsed = this.simpleParse(song, artist, album);
        result.cleanedSong = parsed.song;
        result.cleanedArtist = parsed.artist;
        result.cleanedAlbum = album || parsed.album;
        result.albumName = album || parsed.album;
      }
    }

    // STEP 2: Get album artwork - try online sources first (better quality)
    result.artUrl = await this.fetchAlbumArt(
      result.cleanedSong,
      result.cleanedArtist,
      result.albumName
    );

    // STEP 3: If no online artwork found, use SMTC thumbnail as fallback
    if (!result.artUrl && thumbnailBase64 && thumbnailBase64.length > 100) {
      console.log('🖼️ Using SMTC thumbnail as fallback (no online source found)');
      // Convert to data URL for web compatibility
      result.artUrl = `data:image/png;base64,${thumbnailBase64}`;
    }

    // Cache result
    this.cache.set(cacheKey, result);
    if (this.cache.size > this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    return result;
  }

  /**
   * Fetch ALL metadata from Gemini - this is our primary source for everything
   */
  async fetchMetadataFromAI(song, artist, album) {
    const cacheKey = `ai:${song}|${artist}|${album}`;
    if (this.metadataCache.has(cacheKey)) {
      return this.metadataCache.get(cacheKey);
    }

    const prompt = `You are a music encyclopedia. Provide metadata for this song:

Song: "${song}"
Artist: "${artist}"
${album ? `Album: "${album}"` : ''}

Return ONLY valid JSON (no markdown):
{"song":"exact title","artist":"exact artist","album":"${album || 'album name'}","year":2024,"genre":"genre","label":"label","trackCount":12,"albumDescription":"A detailed paragraph about the album...","artistBio":"A detailed paragraph about the artist..."}

IMPORTANT: albumDescription should be a rich, detailed paragraph (5-6 sentences) covering the album's themes, sound, critical reception, and significance. artistBio should be a rich, detailed paragraph (5-6 sentences) covering the artist's background, career highlights, musical style, and influence. Do NOT write short one-liners.`;

    try {
      const response = await fetch(`${GEMINI_API_URL}?key=${this.geminiApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
        })
      });

      if (!response.ok) {
        throw new Error(`API ${response.status}`);
      }

      const data = await response.json();
      
      // Check if response was truncated
      const finishReason = data.candidates?.[0]?.finishReason;
      if (finishReason && finishReason !== 'STOP') {
        console.log('🤖 Warning: Response truncated, reason:', finishReason);
      }
      
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Empty response');

      let jsonStr = text.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      }

      const parsed = JSON.parse(jsonStr);

      const result = {
        cleanedSong: parsed.song || song,
        cleanedArtist: parsed.artist || artist,
        cleanedAlbum: parsed.album || album,
        albumName: parsed.album || album,
        year: parsed.year || null,
        genre: parsed.genre || null,
        label: parsed.label || null,
        trackCount: parsed.trackCount || null,
        albumDescription: parsed.albumDescription || null,
        artistBio: parsed.artistBio || null
      };

      this.metadataCache.set(cacheKey, result);
      return result;
    } catch (error) {
      console.log('🤖 Parse error:', error.message);
      return null;
    }
  }

  /**
   * Fetch album artwork from multiple sources
   */
  async fetchAlbumArt(song, artist, album) {
    let artUrl = null;

    // 1. Try Cover Art Archive first (best for compilations, free, high quality)
    if (album) {
      console.log('🎼 Trying Cover Art Archive...');
      artUrl = await this.fetchFromCoverArtArchive(album, artist);
      if (artUrl) {
        console.log('🎼 Cover Art Archive artwork found');
        return artUrl;
      }
    }

    // 2. Try iTunes (best quality for mainstream)
    console.log('🍎 Trying iTunes...');
    artUrl = await this.fetchFromItunes(song, artist, album);
    if (artUrl) {
      console.log('🍎 iTunes artwork found');
      return artUrl;
    }

    // 3. Try direct Apple Music lookup (for newer releases)
    console.log('🍏 Trying Apple Music direct...');
    artUrl = await this.fetchFromAppleMusicDirect(artist, album);
    if (artUrl) {
      console.log('🍏 Apple Music direct artwork found');
      return artUrl;
    }

    console.log('❌ No artwork found from any source');
    return null;
  }

  /**
   * iTunes Search API
   */
  async fetchFromItunes(song, artist, album) {
    try {
      // Strategy 1: Search by album
      if (album) {
        const url = `https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${album}`)}&entity=album&limit=10`;
        const response = await fetch(url, { timeout: 5000 });
        const data = await response.json();

        if (data.results?.length > 0) {
          const match = this.findBestMatch(data.results, artist, album, 'collectionName', 'artistName');
          if (match?.artworkUrl100) {
            return match.artworkUrl100.replace('100x100', '600x600');
          }
        }
      }

      // Strategy 2: Search by song
      const songUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${song}`)}&entity=song&limit=10`;
      const songResponse = await fetch(songUrl, { timeout: 5000 });
      const songData = await songResponse.json();

      if (songData.results?.length > 0) {
        const match = this.findBestMatch(songData.results, artist, song, 'trackName', 'artistName');
        if (match?.artworkUrl100) {
          return match.artworkUrl100.replace('100x100', '600x600');
        }
      }
    } catch (e) {
      console.log('iTunes error:', e.message);
    }
    return null;
  }

  /**
   * Cover Art Archive - Primary artwork source
   * Searches by artist + album first to avoid wrong albums with same name
   * Falls back to album-only search for compilations
   * Uses MusicBrainz to find release IDs, then fetches from Cover Art Archive
   */
  async fetchFromCoverArtArchive(album, artist) {
    const userAgent = 'Livia/1.0.0 (https://livia.mom)';
    
    try {
      // Strategy 1: Search by album + artist combined (most accurate)
      console.log(`   Searching for album + artist: "${album}" by "${artist}"`);
      let releaseIds = await this.searchMusicBrainzByAlbumAndArtist(album, artist, userAgent);
      if (releaseIds?.length) {
        const artUrl = await this.getCoverArtArchiveImage(releaseIds, userAgent);
        if (artUrl) return artUrl;
      }
      
      // Strategy 2: Search by ALBUM NAME ONLY (fallback for compilations)
      // This handles cases where track artist differs from album artist
      console.log(`   Fallback: Searching for album only: "${album}"`);
      releaseIds = await this.searchMusicBrainzByAlbum(album, userAgent);
      if (releaseIds?.length) {
        const artUrl = await this.getCoverArtArchiveImage(releaseIds, userAgent);
        if (artUrl) return artUrl;
      }
      
    } catch (e) {
      console.log('Cover Art Archive error:', e.message);
    }
    return null;
  }

  /**
   * Search MusicBrainz by album name only - best for compilations
   */
  async searchMusicBrainzByAlbum(album, userAgent) {
    try {
      // Search for releases with exact album title match
      const query = `release:"${album}"`;
      const searchUrl = `https://musicbrainz.org/ws/2/release?query=${encodeURIComponent(query)}&limit=10&fmt=json`;
      
      const response = await fetch(searchUrl, {
        timeout: 8000,
        headers: { 'User-Agent': userAgent }
      });

      if (!response.ok) return null;
      const data = await response.json();

      if (!data.releases?.length) return null;
      
      // Filter and score releases
      const albumLower = album.toLowerCase();
      const scoredReleases = data.releases
        .filter(release => {
          // Only consider releases where title matches well
          const releaseTitle = release.title?.toLowerCase() || '';
          return releaseTitle === albumLower || 
                 releaseTitle.includes(albumLower) || 
                 albumLower.includes(releaseTitle);
        })
        .map(release => {
          let score = 0;
          const releaseTitle = release.title?.toLowerCase() || '';
          
          // Exact title match gets highest score
          if (releaseTitle === albumLower) score += 100;
          else if (releaseTitle.includes(albumLower)) score += 70;
          else if (albumLower.includes(releaseTitle)) score += 50;
          
          // Prefer official releases
          if (release.status === 'Official') score += 30;
          
          // Prefer releases with more complete data
          if (release.date) score += 10;
          if (release.country) score += 5;
          if (release['track-count'] > 5) score += 10; // Prefer albums over singles
          
          return { release, score };
        });
      
      // Sort by score descending
      scoredReleases.sort((a, b) => b.score - a.score);
      
      // Return top release IDs
      return scoredReleases.slice(0, 5).map(sr => sr.release.id);
      
    } catch (e) {
      return null;
    }
  }

  /**
   * Search MusicBrainz by album + artist
   */
  async searchMusicBrainzByAlbumAndArtist(album, artist, userAgent) {
    try {
      const query = `release:"${album}" AND artist:"${artist}"`;
      const searchUrl = `https://musicbrainz.org/ws/2/release?query=${encodeURIComponent(query)}&limit=10&fmt=json`;
      
      const response = await fetch(searchUrl, {
        timeout: 8000,
        headers: { 'User-Agent': userAgent }
      });

      if (!response.ok) return null;
      const data = await response.json();

      if (!data.releases?.length) return null;
      
      const albumLower = album.toLowerCase();
      const artistLower = artist.toLowerCase();
      
      const scoredReleases = data.releases.map(release => {
        let score = 0;
        const releaseTitle = release.title?.toLowerCase() || '';
        const releaseArtist = release['artist-credit']?.[0]?.name?.toLowerCase() || '';
        
        // Title match
        if (releaseTitle === albumLower) score += 100;
        else if (releaseTitle.includes(albumLower) || albumLower.includes(releaseTitle)) score += 50;
        
        // Artist match
        if (releaseArtist === artistLower) score += 100;
        else if (releaseArtist.includes(artistLower) || artistLower.includes(releaseArtist)) score += 50;
        
        // Prefer official releases
        if (release.status === 'Official') score += 20;
        
        return { release, score };
      });
      
      scoredReleases.sort((a, b) => b.score - a.score);
      return scoredReleases.slice(0, 5).map(sr => sr.release.id);
      
    } catch (e) {
      return null;
    }
  }

  /**
   * Get cover art from Cover Art Archive using the JSON API
   */
  async getCoverArtArchiveImage(releaseIds, userAgent) {
    if (!Array.isArray(releaseIds)) {
      releaseIds = [releaseIds];
    }
    
    for (const releaseId of releaseIds) {
      try {
        const apiUrl = `https://coverartarchive.org/release/${releaseId}`;
        const response = await fetch(apiUrl, {
          timeout: 5000,
          headers: { 
            'User-Agent': userAgent,
            'Accept': 'application/json'
          }
        });

        if (!response.ok) continue;
        
        const data = await response.json();
        
        if (!data.images?.length) continue;
        
        // Find the front cover image
        let frontImage = data.images.find(img => img.front === true);
        if (!frontImage) {
          frontImage = data.images.find(img => img.approved === true);
        }
        if (!frontImage) {
          frontImage = data.images[0];
        }
        
        if (!frontImage) continue;
        
        // Get best quality: 500px is good balance of quality and size
        const thumbnails = frontImage.thumbnails || {};
        const imageUrl = 
          thumbnails['500'] ||
          thumbnails['large'] ||
          thumbnails['1200'] ||
          thumbnails['250'] ||
          frontImage.image;
        
        if (imageUrl) {
          return imageUrl;
        }
        
      } catch (e) {
        continue;
      }
    }
    
    return null;
  }

  /**
   * iTunes Search API
   */
  async fetchFromLastFm(song, artist, album) {
    try {
      // Try album lookup
      if (album) {
        const url = `https://ws.audioscrobbler.com/2.0/?method=album.getinfo&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}&api_key=${this.lastFmApiKey}&format=json`;
        const response = await fetch(url, { timeout: 5000 });
        const data = await response.json();

        const artUrl = this.extractLastFmImage(data.album?.image);
        if (artUrl) return artUrl;
      }

      // Try track lookup
      const trackUrl = `https://ws.audioscrobbler.com/2.0/?method=track.getinfo&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(song)}&api_key=${this.lastFmApiKey}&format=json`;
      const trackResponse = await fetch(trackUrl, { timeout: 5000 });
      const trackData = await trackResponse.json();

      const trackArt = this.extractLastFmImage(trackData.track?.album?.image);
      if (trackArt) return trackArt;
    } catch (e) {
      console.log('Last.fm error:', e.message);
    }
    return null;
  }

  /**
   * Direct Apple Music catalog search (different endpoint, may have newer releases)
   */
  async fetchFromAppleMusicDirect(artist, album) {
    if (!album) return null;
    
    try {
      // Apple's storefront search (no auth needed)
      const searchTerm = `${artist} ${album}`.replace(/[^\w\s]/g, ' ');
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&media=music&entity=album&limit=25`;
      
      const response = await fetch(url, { timeout: 5000 });
      const data = await response.json();

      if (data.results?.length > 0) {
        // Look for exact or close match
        const albumLower = album.toLowerCase();
        const artistLower = artist.toLowerCase();

        for (const result of data.results) {
          const resultAlbum = (result.collectionName || '').toLowerCase();
          const resultArtist = (result.artistName || '').toLowerCase();

          // Check for match
          if (resultArtist.includes(artistLower) || artistLower.includes(resultArtist)) {
            if (resultAlbum.includes(albumLower) || albumLower.includes(resultAlbum) ||
                this.similarStrings(resultAlbum, albumLower)) {
              if (result.artworkUrl100) {
                return result.artworkUrl100.replace('100x100', '600x600');
              }
            }
          }
        }
      }
    } catch (e) {
      console.log('Apple Music direct error:', e.message);
    }
    return null;
  }

  /**
   * Helper: Find best matching result
   */
  findBestMatch(results, artist, searchTerm, termField, artistField) {
    const searchLower = searchTerm?.toLowerCase() || '';
    const artistLower = artist?.toLowerCase() || '';

    let bestMatch = null;
    let bestScore = 0;

    for (const result of results) {
      let score = 0;
      const resultTerm = (result[termField] || '').toLowerCase();
      const resultArtist = (result[artistField] || '').toLowerCase();

      // Artist match
      if (resultArtist === artistLower) score += 100;
      else if (resultArtist.includes(artistLower) || artistLower.includes(resultArtist)) score += 50;

      // Term match
      if (resultTerm === searchLower) score += 100;
      else if (resultTerm.includes(searchLower) || searchLower.includes(resultTerm)) score += 50;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = result;
      }
    }

    return bestScore >= 50 ? bestMatch : results[0];
  }

  /**
   * Helper: Check string similarity
   */
  similarStrings(a, b) {
    if (!a || !b) return false;
    const cleanA = a.replace(/[^\w]/g, '').toLowerCase();
    const cleanB = b.replace(/[^\w]/g, '').toLowerCase();
    return cleanA === cleanB || cleanA.includes(cleanB) || cleanB.includes(cleanA);
  }

  /**
   * Fallback parser
   */
  simpleParse(song, artist, album) {
    let parsedSong = song || '';
    let parsedArtist = artist || '';
    let parsedAlbum = album || '';

    const separators = [' — ', ' - ', ' – '];
    for (const sep of separators) {
      if (parsedArtist.includes(sep)) {
        const parts = parsedArtist.split(sep).map(p => p.trim());
        parsedArtist = parts[0];
        if (!parsedAlbum && parts[1]) parsedAlbum = parts[1];
        break;
      }
    }

    const suffixes = [/ \(Official.*?\)/gi, / \[Official.*?\]/gi, / \(Lyrics?\)/gi, / \(Audio\)/gi, / \(Video\)/gi];
    for (const suffix of suffixes) {
      parsedSong = parsedSong.replace(suffix, '');
    }

    return { song: parsedSong.trim(), artist: parsedArtist.trim(), album: parsedAlbum.trim() || null };
  }

  clearCache() {
    this.cache.clear();
    this.metadataCache.clear();
  }
}

module.exports = AlbumArtFetcher;
