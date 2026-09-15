import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma';

interface EvolutionGroup {
  id: string;
  subject: string;
  subjectTime?: number;
  subjectOwner?: string;
  size: number;
  creation: number;
  owner: string;
  desc?: string;
  descId?: string;
  restrict?: boolean;
  announce?: boolean;
  isCommunity?: boolean;
  isCommunityAnnounce?: boolean;
}

interface WhatsAppGroupItem {
  id: string;
  name: string;
}

/** Extracts the invite code from a `https://chat.whatsapp.com/<code>` URL, or null if it doesn't match. */
export function extractWhatsAppInviteCode(url: string): string | null {
  const match = url.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
  return match ? match[1] : null;
}

export class WhatsAppService {
  private async getConfig(): Promise<{
    baseUrl: string;
    apiKey: string;
    instance: string;
  }> {
    const [urlSetting, keySetting, instanceSetting] = await Promise.all([
      prisma.setting.findUnique({ where: { key: 'evolution_api_url' } }),
      prisma.setting.findUnique({ where: { key: 'evolution_api_key' } }),
      prisma.setting.findUnique({ where: { key: 'evolution_instance' } }),
    ]);

    const baseUrl = urlSetting?.value?.trim();
    const apiKey = keySetting?.value?.trim();
    const instance = instanceSetting?.value?.trim();

    if (!baseUrl) throw new Error('evolution_api_url is not configured in settings');
    if (!apiKey) throw new Error('evolution_api_key is not configured in settings');
    if (!instance) throw new Error('evolution_instance is not configured in settings');

    return { baseUrl: baseUrl.replace(/\/$/, ''), apiKey, instance };
  }

  private async getClient(): Promise<{ client: AxiosInstance; instance: string }> {
    const { baseUrl, apiKey, instance } = await this.getConfig();
    const client = axios.create({
      baseURL: baseUrl,
      headers: {
        apikey: apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 60000, // 60s — listing groups can be slow on large instances
    });
    return { client, instance };
  }

  async testConnection(): Promise<boolean> {
    try {
      const { client, instance } = await this.getClient();
      const response = await client.get(`/instance/connectionState/${instance}`);
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async listGroups(): Promise<WhatsAppGroupItem[]> {
    const { client, instance } = await this.getClient();
    const response = await client.get<EvolutionGroup[]>(
      `/group/fetchAllGroups/${instance}?getParticipants=false`,
    );

    return (response.data ?? []).map((g) => ({
      id: g.id,
      name: g.subject,
    }));
  }

  /**
   * Checks whether a WhatsApp group invite link (chat.whatsapp.com/<code>) is
   * still valid, without joining the group — via Evolution API's read-only
   * invite lookup. Only a definite yes/no ("valid"/"revoked or expired")
   * resolves; anything inconclusive (Evolution API/instance unreachable,
   * unexpected error) throws instead of guessing, so callers don't mistake a
   * transient outage for the link actually being dead.
   */
  async checkInviteLink(url: string): Promise<{ valid: boolean; groupName?: string }> {
    const code = extractWhatsAppInviteCode(url);
    if (!code) throw new Error(`Not a valid chat.whatsapp.com invite URL: ${url}`);

    const { client, instance } = await this.getClient();
    try {
      const response = await client.get(`/group/inviteInfo/${instance}`, {
        params: { inviteCode: code },
      });
      const groupName = response.data?.subject ?? response.data?.name;
      return { valid: true, groupName };
    } catch (err: any) {
      const status = err.response?.status;
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      // 401/403 means OUR credentials were rejected, not that the invite code
      // was — treating that as "link invalid" would mass-flag every monitored
      // group as expired the moment evolution_api_key is wrong/rotated.
      if (status === 401 || status === 403) {
        throw new Error(`Evolution API rejected our credentials while checking invite link (${status}): ${detail} — check evolution_api_key`);
      }
      // Any other 4xx means Evolution API understood the request and the
      // invite code itself was rejected (revoked/expired/not found) — that's
      // a confident "invalid". Anything else (network error, timeout, 5xx) is
      // inconclusive — bubble it up rather than reporting a false "invalid".
      if (status >= 400 && status < 500) {
        return { valid: false };
      }
      throw new Error(`Evolution API inviteInfo check failed (${status ?? '?'}): ${detail}`);
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const { client, instance } = await this.getClient();
    try {
      const response = await client.post(`/message/sendText/${instance}`, {
        number: chatId,
        text,                    // Evolution API v2 — top-level field (not textMessage:{text})
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Evolution API sendText failed with status ${response.status}`);
      }
    } catch (err: any) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      throw new Error(`Evolution API sendText failed (${err.response?.status ?? '?'}): ${detail}`);
    }
  }

  async sendImage(chatId: string, imagePath: string, caption?: string): Promise<void> {
    const mediaBasePath = process.env.MEDIA_BASE_PATH || '/app/media';
    const absolutePath = path.isAbsolute(imagePath) ? imagePath : path.join(mediaBasePath, imagePath);

    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Image file not found: ${absolutePath}`);
    }

    // Convert to base64 for Evolution API
    const fileContent = fs.readFileSync(absolutePath);
    const base64 = fileContent.toString('base64');
    const ext = path.extname(absolutePath).replace('.', '').toLowerCase();
    const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;

    const { client, instance } = await this.getClient();
    try {
      const response = await client.post(`/message/sendMedia/${instance}`, {
        number: chatId,
        // Evolution API v2 top-level fields
        mediatype: 'image',
        mimetype: mimeType,
        // Raw base64 — NOT a data URI. Evolution API does
        // `Buffer.from(media, 'base64')` directly; a "data:image/jpeg;base64,"
        // prefix gets decoded as part of the payload, corrupting the image
        // and making their sharp() re-encode step fail with a 400.
        media: base64,
        caption: caption ?? '',
        fileName: path.basename(absolutePath),
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Evolution API sendImage failed with status ${response.status}`);
      }
    } catch (err: any) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      throw new Error(`Evolution API sendImage failed (${err.response?.status ?? '?'}): ${detail}`);
    }
  }

  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<void> {
    const mediaBasePath = process.env.MEDIA_BASE_PATH || '/app/media';
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(mediaBasePath, filePath);

    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Document file not found: ${absolutePath}`);
    }

    const fileContent = fs.readFileSync(absolutePath);
    const base64 = fileContent.toString('base64');
    const fileName = path.basename(absolutePath);
    const ext = path.extname(absolutePath).replace('.', '').toLowerCase();
    const mimeType = `application/${ext === 'pdf' ? 'pdf' : 'octet-stream'}`;

    const { client, instance } = await this.getClient();
    try {
      const response = await client.post(`/message/sendMedia/${instance}`, {
        number: chatId,
        // Evolution API v2 top-level fields
        mediatype: 'document',
        mimetype: mimeType,
        media: base64, // raw base64, not a data URI — see sendImage() for why
        caption: caption ?? '',
        fileName,
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Evolution API sendDocument failed with status ${response.status}`);
      }
    } catch (err: any) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      throw new Error(`Evolution API sendDocument failed (${err.response?.status ?? '?'}): ${detail}`);
    }
  }
}
