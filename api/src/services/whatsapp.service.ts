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

  async sendText(chatId: string, text: string): Promise<void> {
    const { client, instance } = await this.getClient();
    const response = await client.post(`/message/sendText/${instance}`, {
      number: chatId,
      text,                    // Evolution API v2 — top-level field (not textMessage:{text})
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Evolution API sendText failed with status ${response.status}`);
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
    const response = await client.post(`/message/sendMedia/${instance}`, {
      number: chatId,
      // Evolution API v2 top-level fields
      mediatype: 'image',
      media: `data:${mimeType};base64,${base64}`,
      caption: caption ?? '',
      fileName: path.basename(absolutePath),
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Evolution API sendImage failed with status ${response.status}`);
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
    const response = await client.post(`/message/sendMedia/${instance}`, {
      number: chatId,
      // Evolution API v2 top-level fields
      mediatype: 'document',
      media: `data:${mimeType};base64,${base64}`,
      caption: caption ?? '',
      fileName,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Evolution API sendDocument failed with status ${response.status}`);
    }
  }
}
