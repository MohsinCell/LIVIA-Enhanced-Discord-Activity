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
   */
  async getAlbumInfo(song, artist, album = null, thumbnailBase64 = null) {
    // Pre-process: Some apps combine artist and album in the artist field
    if (artist && !album) {
      const separators = [' - ', ' — ', ' – '];
      for (const sep of separators) {
        if (artist.includes(sep)) {
          const parts = artist.split(sep);
          if (parts.length >= 2) {
            artist = parts[0].trim();
            album = parts.slice(1).join(sep).trim();
            console.log(`Split artist/album: "${artist}" / "${album}"`);
            break;
          }
        }
      }
    }
    
    console.log(`Input: song="${song}" artist="${artist}" album="${album}"`);

    const cacheKey = `${song?.toLowerCase()}-${artist?.toLowerCase()}`;
    if (this.cache.has(cacheKey)) {
      console.log('Using cached album info');
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
      artistImage: null,
      cleanedSong: song,
      cleanedArtist: artist,
      cleanedAlbum: album
    };

    // Get ALL metadata from Gemini AI
    if (this.geminiApiKey) {
      try {
        console.log('Fetching metadata from Gemini...');
        const aiMetadata = await this.fetchMetadataFromAI(song, artist, album);
        if (aiMetadata) {
          result = { ...result, ...aiMetadata };
          if (album) {
            result.albumName = album;
            result.cleanedAlbum = album;
          }
          console.log(`Gemini: "${result.cleanedSong}" by ${result.cleanedArtist}`);
        }
      } catch (error) {
        console.log('Gemini failed:', error.message);
        const parsed = this.simpleParse(song, artist, album);
        result.cleanedSong = parsed.song;
        result.cleanedArtist = parsed.artist;
        result.cleanedAlbum = album || parsed.album;
        result.albumName = album || parsed.album;
      }
    }

    // Get album artwork
    result.artUrl = await this.fetchAlbumArt(
      result.cleanedSong,
      result.cleanedArtist,
      result.albumName
    );

    // Use SMTC thumbnail if no online artwork
    if (!result.artUrl && thumbnailBase64 && thumbnailBase64.length > 100) {
      console.log('Using SMTC thumbnail as fallback');
      result.artUrl = `data:image/png;base64,${thumbnailBase64}`;
    }

    this.cache.set(cacheKey, result);
    if (this.cache.size > this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    return result;
  }

  /**
   * Fetch ALL metadata from Gemini
   */
  async fetchMetadataFromAI(song, artist, album) {
    const cacheKey = `ai:${song}|${artist}|${album}`;
    if (this.metadataCache.has(cacheKey)) {
      return this.metadataCache.get(cacheKey);
    }

    const prompt = `You are a music encyclopedia. Provide metadata for this song.

Song: "${song}"
Artist: "${artist}"
${album ? `Album: "${album}"` : ''}

Return ONLY valid JSON (no markdown):
{"song":"exact title","artist":"exact artist","album":"${album || 'album name'}","year":2024,"genre":"genre","label":"label","trackCount":12,"albumDescription":"A detailed paragraph about the album...","artistBio":"A detailed paragraph about the artist...","artistImage":"https://example.com/artist.jpg"}

IMPORTANT: albumDescription should be 5-6 sentences about the album. artistBio should be 5-6 sentences about the artist. artistImage should be a direct URL to a photo of the artist, or null if not found.`;

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
      const finishReason = data.candidates?.[0]?.finishReason;
      if (finishReason && finishReason !== 'STOP') {
        console.log('Warning: Response truncated:', finishReason);
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
        artistBio: parsed.artistBio || null,
        artistImage: parsed.artistImage || null
      };

      this.metadataCache.set(cacheKey, result);
      return result;
    } catch (error) {
      console.log('Parse error:', error.message);
      return null;
    }
  }

  /**
   * Fetch album artwork from multiple sources
   */
  async fetchAlbumArt(song, artist, album) {
    let artUrl = null;

    // 1. Try Cover Art Archive first
    if (album) {
      console.log('Trying Cover Art Archive...');
      artUrl = await this.fetchFromCoverArtArchive(album, artist);
      if (artUrl) {
        console.log('Cover Art Archive artwork found');
        return artUrl;
      }
    }

    // 2. Try iTunes
    console.log('Trying iTunes...');
    artUrl = await this.fetchFromItunes(song, artist, album);
    if (artUrl) {
      console.log('iTunes artwork found');
      return artUrl;
    }

    // 3. Try Apple Music direct
    console.log('Trying Apple Music direct...');
    artUrl = await this.fetchFromAppleMusicDirect(artist, album);
    if (artUrl) {
      console.log('Apple Music direct artwork found');
      return artUrl;
    }

    console.log('No artwork found from any source');
    return null;
  }

  /**
   * iTunes Search API
   */
  async fetchFromItunes(song, artist, album) {
    try {
      if (album) {
        const url = `https://itunes.apple.com/search?term=${encodeURIComponent(artist + ' ' + album)}&entity=album&limit=10`;
        const response = await fetch(url, { timeout: 5000 });
        const data = await response.json();

        if (data.results?.length > 0) {
          const match = this.findBestMatch(data.results, artist, album, 'collectionName', 'artistName');
          if (match?.artworkUrl100) {
            return match.artworkUrl100.replace('100x100', '600x600');
          }
        }
      }

      const songUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(artist + ' ' + song)}&entity=song&limit=10`;
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
   * Cover Art Archive - Enhanced with release-group support
   * Strategy:
   * 1. Search release-groups by artist + album (most accurate)
   * 2. Search releases by artist + album (fallback)
   * 3. Search release-groups by album only (broader search)
   * 4. Search releases by album only (last resort)
   */
  async fetchFromCoverArtArchive(album, artist) {
    const userAgent = 'Livia/1.0.0 (https://livia.mom)';
    
    try {
      // 1. Try release-groups first (best for finding cover art)
      console.log(`Searching release-groups for: "${album}" by "${artist}"`);
      let releaseGroupIds = await this.searchMusicBrainzReleaseGroups(album, artist, userAgent);
      if (releaseGroupIds?.length) {
        const artUrl = await this.getCoverArtFromReleaseGroups(releaseGroupIds, userAgent);
        if (artUrl) {
          console.log('Found cover art via release-group');
          return artUrl;
        }
      }
      
      // 2. Try releases by artist + album
      console.log(`Searching releases for: "${album}" by "${artist}"`);
      let releaseIds = await this.searchMusicBrainzByAlbumAndArtist(album, artist, userAgent);
      if (releaseIds?.length) {
        const artUrl = await this.getCoverArtArchiveImage(releaseIds, userAgent);
        if (artUrl) return artUrl;
      }
      
      // 3. Try release-groups by album only
      console.log(`Fallback: Searching release-groups for album only: "${album}"`);
      releaseGroupIds = await this.searchMusicBrainzReleaseGroups(album, null, userAgent);
      if (releaseGroupIds?.length) {
        const artUrl = await this.getCoverArtFromReleaseGroups(releaseGroupIds, userAgent);
        if (artUrl) return artUrl;
      }
      
      // 4. Fallback: releases by album only
      console.log(`Fallback: Searching releases for album only: "${album}"`);
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
   * Search MusicBrainz for release-groups (albums bundled across all editions)
   */
  async searchMusicBrainzReleaseGroups(album, artist, userAgent) {
    try {
      // Build query
      let query = `releasegroup:"${album}"`;
      if (artist) {
        query += ` AND artist:"${artist}"`;
      }
      
      const searchUrl = `https://musicbrainz.org/ws/2/release-group?query=${encodeURIComponent(query)}&limit=10&fmt=json`;
      
      const response = await fetch(searchUrl, {
        timeout: 8000,
        headers: { 'User-Agent': userAgent }
      });

      if (!response.ok) return null;
      const data = await response.json();

      if (!data['release-groups']?.length) return null;
      
      const albumLower = album.toLowerCase();
      const artistLower = artist?.toLowerCase() || '';
      
      const scoredGroups = data['release-groups'].map(group => {
        let score = group.score || 0;
        const groupTitle = group.title?.toLowerCase() || '';
        const groupArtist = group['artist-credit']?.[0]?.name?.toLowerCase() || '';
        
        // Title matching
        if (groupTitle === albumLower) score += 100;
        else if (groupTitle.includes(albumLower) || albumLower.includes(groupTitle)) score += 50;
        
        // Artist matching
        if (artist) {
          if (groupArtist === artistLower) score += 100;
          else if (groupArtist.includes(artistLower) || artistLower.includes(groupArtist)) score += 50;
        }
        
        // Prefer albums over singles/EPs
        if (group['primary-type'] === 'Album') score += 30;
        else if (group['primary-type'] === 'EP') score += 15;
        
        return { group, score };
      });
      
      scoredGroups.sort((a, b) => b.score - a.score);
      return scoredGroups.slice(0, 5).map(sg => sg.group.id);
      
    } catch (e) {
      console.log('Release-group search error:', e.message);
      return null;
    }
  }

  /**
   * Get cover art from release-groups
   */
  async getCoverArtFromReleaseGroups(releaseGroupIds, userAgent) {
    if (!Array.isArray(releaseGroupIds)) {
      releaseGroupIds = [releaseGroupIds];
    }
    
    for (const groupId of releaseGroupIds) {
      try {
        // Cover Art Archive has a release-group endpoint
        const apiUrl = `https://coverartarchive.org/release-group/${groupId}`;
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
        
        // Prefer front cover
        let frontImage = data.images.find(img => img.front === true);
        if (!frontImage) {
          frontImage = data.images.find(img => img.approved === true);
        }
        if (!frontImage) {
          frontImage = data.images[0];
        }
        
        if (!frontImage) continue;
        
        const thumbnails = frontImage.thumbnails || {};
        const imageUrl = 
          thumbnails['500'] ||
          thumbnails['large'] ||
          thumbnails['1200'] ||
          thumbnails['250'] ||
          frontImage.image;
        
        if (imageUrl) {
          // Ensure HTTPS
          return imageUrl.replace(/^http:\/\//, 'https://');
        }
        
      } catch (e) {
        continue;
      }
    }
    
    return null;
  }

  async searchMusicBrainzByAlbum(album, userAgent) {
    try {
      const query = `release:"${album}"`;
      const searchUrl = `https://musicbrainz.org/ws/2/release?query=${encodeURIComponent(query)}&limit=10&fmt=json`;
      
      const response = await fetch(searchUrl, {
        timeout: 8000,
        headers: { 'User-Agent': userAgent }
      });

      if (!response.ok) return null;
      const data = await response.json();

      if (!data.releases?.length) return null;
      
      const albumLower = album.toLowerCase();
      const scoredReleases = data.releases
        .filter(release => {
          const releaseTitle = release.title?.toLowerCase() || '';
          return releaseTitle === albumLower || 
                 releaseTitle.includes(albumLower) || 
                 albumLower.includes(releaseTitle);
        })
        .map(release => {
          let score = 0;
          const releaseTitle = release.title?.toLowerCase() || '';
          
          if (releaseTitle === albumLower) score += 100;
          else if (releaseTitle.includes(albumLower)) score += 70;
          else if (albumLower.includes(releaseTitle)) score += 50;
          
          if (release.status === 'Official') score += 30;
          if (release.date) score += 10;
          if (release.country) score += 5;
          if (release['track-count'] > 5) score += 10;
          
          return { release, score };
        });
      
      scoredReleases.sort((a, b) => b.score - a.score);
      return scoredReleases.slice(0, 5).map(sr => sr.release.id);
      
    } catch (e) {
      return null;
    }
  }

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
        
        if (releaseTitle === albumLower) score += 100;
        else if (releaseTitle.includes(albumLower) || albumLower.includes(releaseTitle)) score += 50;
        
        if (releaseArtist === artistLower) score += 100;
        else if (releaseArtist.includes(artistLower) || artistLower.includes(releaseArtist)) score += 50;
        
        if (release.status === 'Official') score += 20;
        
        return { release, score };
      });
      
      scoredReleases.sort((a, b) => b.score - a.score);
      return scoredReleases.slice(0, 5).map(sr => sr.release.id);
      
    } catch (e) {
      return null;
    }
  }

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
        
        let frontImage = data.images.find(img => img.front === true);
        if (!frontImage) {
          frontImage = data.images.find(img => img.approved === true);
        }
        if (!frontImage) {
          frontImage = data.images[0];
        }
        
        if (!frontImage) continue;
        
        const thumbnails = frontImage.thumbnails || {};
        const imageUrl = 
          thumbnails['500'] ||
          thumbnails['large'] ||
          thumbnails['1200'] ||
          thumbnails['250'] ||
          frontImage.image;
        
        if (imageUrl) {
          // Ensure HTTPS
          return imageUrl.replace(/^http:\/\//, 'https://');
        }
        
      } catch (e) {
        continue;
      }
    }
    
    return null;
  }
      
      // Fallback: album only
      console.log(`Fallback: Searching for album only: "${album}"`);
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

  async searchMusicBrainzByAlbum(album, userAgent) {
    try {
      const query = `release:"${album}"`;
      const searchUrl = `https://musicbrainz.org/ws/2/release?query=${encodeURIComponent(query)}&limit=10&fmt=json`;
      
      const response = await fetch(searchUrl, {
        timeout: 8000,
        headers: { 'User-Agent': userAgent }
      });

      if (!response.ok) return null;
      const data = await response.json();

      if (!data.releases?.length) return null;
      
      const albumLower = album.toLowerCase();
      const scoredReleases = data.releases
        .filter(release => {
          const releaseTitle = release.title?.toLowerCase() || '';
          return releaseTitle === albumLower || 
                 releaseTitle.includes(albumLower) || 
                 albumLower.includes(releaseTitle);
        })
        .map(release => {
          let score = 0;
          const releaseTitle = release.title?.toLowerCase() || '';
          
          if (releaseTitle === albumLower) score += 100;
          else if (releaseTitle.includes(albumLower)) score += 70;
          else if (albumLower.includes(releaseTitle)) score += 50;
          
          if (release.status === 'Official') score += 30;
          if (release.date) score += 10;
          if (release.country) score += 5;
          if (release['track-count'] > 5) score += 10;
          
          return { release, score };
        });
      
      scoredReleases.sort((a, b) => b.score - a.score);
      return scoredReleases.slice(0, 5).map(sr => sr.release.id);
      
    } catch (e) {
      return null;
    }
  }

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
        
        if (releaseTitle === albumLower) score += 100;
        else if (releaseTitle.includes(albumLower) || albumLower.includes(releaseTitle)) score += 50;
        
        if (releaseArtist === artistLower) score += 100;
        else if (releaseArtist.includes(artistLower) || artistLower.includes(releaseArtist)) score += 50;
        
        if (release.status === 'Official') score += 20;
        
        return { release, score };
      });
      
      scoredReleases.sort((a, b) => b.score - a.score);
      return scoredReleases.slice(0, 5).map(sr => sr.release.id);
      
    } catch (e) {
      return null;
    }
  }

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
        
        let frontImage = data.images.find(img => img.front === true);
        if (!frontImage) {
          frontImage = data.images.find(img => img.approved === true);
        }
        if (!frontImage) {
          frontImage = data.images[0];
        }
        
        if (!frontImage) continue;
        
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

  async fetchFromAppleMusicDirect(artist, album) {
    if (!album) return null;
    
    try {
      const searchTerm = `${artist} ${album}`.replace(/[^\w\s]/g, ' ');
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&media=music&entity=album&limit=25`;
      
      const response = await fetch(url, { timeout: 5000 });
      const data = await response.json();

      if (data.results?.length > 0) {
        const albumLower = album.toLowerCase();
        const artistLower = artist.toLowerCase();

        for (const result of data.results) {
          const resultAlbum = (result.collectionName || '').toLowerCase();
          const resultArtist = (result.artistName || '').toLowerCase();

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

  findBestMatch(results, artist, searchTerm, termField, artistField) {
    const searchLower = searchTerm?.toLowerCase() || '';
    const artistLower = artist?.toLowerCase() || '';

    let bestMatch = null;
    let bestScore = 0;

    for (const result of results) {
      let score = 0;
      const resultTerm = (result[termField] || '').toLowerCase();
      const resultArtist = (result[artistField] || '').toLowerCase();

      if (resultArtist === artistLower) score += 100;
      else if (resultArtist.includes(artistLower) || artistLower.includes(resultArtist)) score += 50;

      if (resultTerm === searchLower) score += 100;
      else if (resultTerm.includes(searchLower) || searchLower.includes(resultTerm)) score += 50;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = result;
      }
    }

    return bestScore >= 50 ? bestMatch : results[0];
  }

  similarStrings(a, b) {
    if (!a || !b) return false;
    const cleanA = a.replace(/[^\w]/g, '').toLowerCase();
    const cleanB = b.replace(/[^\w]/g, '').toLowerCase();
    return cleanA === cleanB || cleanA.includes(cleanB) || cleanB.includes(cleanA);
  }

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
