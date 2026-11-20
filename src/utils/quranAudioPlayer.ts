import type { QuranReciterSpec } from '../types/nonoland';

export type QuranPlaybackStatus =
  | 'idle'
  | 'playing'
  | 'repeat-window'
  | 'paused'
  | 'completed'
  | 'unavailable'
  | 'error';

export interface QuranPlayerState {
  status: QuranPlaybackStatus;
  surahId: string | null;
  ayahNumber: number | null;
  currentRepeatIndex: number;
  totalRepeats: number;
  repeatWindowSecondsLeft: number;
  errorMessage?: string;
}

/**
 * Resolve verified audio URL for a Surah or Ayah from a verified & licensed reciter.
 * Strictly prohibits speechSynthesis, TTS fallback, or unverified reciters.
 */
export function resolveVerifiedAudioUrl(
  reciter: QuranReciterSpec | null | undefined,
  surahId: string,
  ayahNumber?: number,
): string | null {
  if (!reciter || reciter.verificationStatus !== 'verified') {
    return null;
  }
  if (ayahNumber !== undefined && reciter.ayahAudioUrls) {
    const surahPrefix = surahId.replace('surah-', '');
    const key = `${surahPrefix}:${ayahNumber}`;
    const ayahUrl = reciter.ayahAudioUrls[key];
    if (ayahUrl && (ayahUrl.startsWith('https://') || ayahUrl.startsWith('/assets/quran/'))) {
      return ayahUrl;
    }
  }
  const surahUrl = reciter.surahAudioUrls?.[surahId];
  if (surahUrl && (surahUrl.startsWith('https://') || surahUrl.startsWith('/assets/quran/'))) {
    return surahUrl;
  }
  return null;
}

export class QuranAudioController {
  private audio: HTMLAudioElement | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private cancelled = false;
  private state: QuranPlayerState = {
    status: 'idle',
    surahId: null,
    ayahNumber: null,
    currentRepeatIndex: 1,
    totalRepeats: 1,
    repeatWindowSecondsLeft: 0,
  };
  private onState: (next: QuranPlayerState) => void;

  constructor(onState: (next: QuranPlayerState) => void) {
    this.onState = onState;
  }

  private emit(patch: Partial<QuranPlayerState>) {
    this.state = { ...this.state, ...patch };
    this.onState({ ...this.state });
  }

  private clearTimers() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  private cleanupAudio() {
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      this.audio = null;
    }
  }

  public stop() {
    this.cancelled = true;
    this.clearTimers();
    this.cleanupAudio();
    this.emit({
      status: 'idle',
      currentRepeatIndex: 1,
      repeatWindowSecondsLeft: 0,
      errorMessage: undefined,
    });
  }

  public pause() {
    if (this.audio && !this.audio.paused) {
      this.audio.pause();
      this.emit({ status: 'paused' });
    }
  }

  public resume() {
    if (this.audio && this.state.status === 'paused') {
      void this.audio.play().then(() => {
        this.emit({ status: 'playing' });
      }).catch(() => {
        this.emit({ status: 'error', errorMessage: 'Unable to resume Quran audio playback.' });
      });
    }
  }

  private playSingleUrl(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.cancelled || typeof Audio === 'undefined') {
        resolve(false);
        return;
      }
      this.cleanupAudio();
      const audio = new Audio(url);
      audio.preload = 'auto';
      this.audio = audio;

      const onEnded = () => {
        cleanupListeners();
        resolve(true);
      };
      const onError = () => {
        cleanupListeners();
        resolve(false);
      };
      const cleanupListeners = () => {
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('error', onError);
      };

      audio.addEventListener('ended', onEnded);
      audio.addEventListener('error', onError);

      void audio.play().catch(() => {
        cleanupListeners();
        resolve(false);
      });
    });
  }

  private waitRepeatWindow(seconds: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.cancelled || seconds <= 0) {
        resolve(!this.cancelled);
        return;
      }
      this.clearTimers();
      let remaining = seconds;
      this.emit({
        status: 'repeat-window',
        repeatWindowSecondsLeft: remaining,
      });

      this.countdownTimer = setInterval(() => {
        if (this.cancelled) {
          this.clearTimers();
          resolve(false);
          return;
        }
        remaining -= 1;
        if (remaining <= 0) {
          this.clearTimers();
          this.emit({ repeatWindowSecondsLeft: 0 });
          resolve(true);
        } else {
          this.emit({ repeatWindowSecondsLeft: remaining });
        }
      }, 1000);
    });
  }

  public async playWithRepeat(opts: {
    reciter: QuranReciterSpec | null | undefined;
    surahId: string;
    ayahNumber?: number;
    repeatCount?: number;
    repeatPauseSeconds?: number;
  }): Promise<boolean> {
    this.stop();
    this.cancelled = false;

    const url = resolveVerifiedAudioUrl(opts.reciter, opts.surahId, opts.ayahNumber);
    if (!url) {
      this.emit({
        status: 'unavailable',
        surahId: opts.surahId,
        ayahNumber: opts.ayahNumber ?? null,
        totalRepeats: 1,
        currentRepeatIndex: 1,
        repeatWindowSecondsLeft: 0,
      });
      return false;
    }

    const totalRepeats = Math.max(1, Math.min(5, Math.round(opts.repeatCount ?? 1)));
    const pauseSecs = Math.max(0, Math.min(8, Math.round(opts.repeatPauseSeconds ?? 0)));

    for (let i = 1; i <= totalRepeats; i += 1) {
      if (this.cancelled) return false;
      this.emit({
        status: 'playing',
        surahId: opts.surahId,
        ayahNumber: opts.ayahNumber ?? null,
        currentRepeatIndex: i,
        totalRepeats,
        repeatWindowSecondsLeft: 0,
        errorMessage: undefined,
      });

      const played = await this.playSingleUrl(url);
      if (this.cancelled) return false;
      if (!played) {
        this.emit({
          status: 'error',
          errorMessage: 'Audio file could not be loaded.',
        });
        return false;
      }

      if (pauseSecs > 0) {
        const waited = await this.waitRepeatWindow(pauseSecs);
        if (!waited) return false;
      }
    }

    this.emit({
      status: 'completed',
      repeatWindowSecondsLeft: 0,
    });
    return true;
  }

  public dispose() {
    this.stop();
  }
}
