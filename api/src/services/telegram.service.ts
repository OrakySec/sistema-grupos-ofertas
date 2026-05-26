import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma';

export class TelegramService {
  private async getBotToken(): Promise<string> {
    const setting = await prisma.setting.findUnique({
      where: { key: 'telegram_bot_token' },
    });
    const token = setting?.value?.trim();
    if (!token) {
      throw new Error('telegram_bot_token is not configured in settings');
    }
    return token;
  }

  private async getApiUrl(): Promise<string> {
    const token = await this.getBotToken();
    return `https://api.telegram.org/bot${token}`;
  }

  async testConnection(): Promise<boolean> {
    try {
      const apiUrl = await this.getApiUrl();
      const response = await axios.get(`${apiUrl}/getMe`, { timeout: 10000 });
      return response.data?.ok === true;
    } catch {
      return false;
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const apiUrl = await this.getApiUrl();
    const response = await axios.post(
      `${apiUrl}/sendMessage`,
      {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
      },
      { timeout: 30000 },
    );

    if (!response.data?.ok) {
      throw new Error(
        `Telegram sendMessage failed: ${JSON.stringify(response.data)}`,
      );
    }
  }

  async sendPhoto(chatId: string, photoPath: string, caption?: string): Promise<void> {
    const apiUrl = await this.getApiUrl();
    const absolutePath = path.resolve(photoPath);

    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Photo file not found: ${absolutePath}`);
    }

    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('photo', fs.createReadStream(absolutePath));
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
    }

    const response = await axios.post(`${apiUrl}/sendPhoto`, form, {
      headers: form.getHeaders(),
      timeout: 60000,
    });

    if (!response.data?.ok) {
      throw new Error(
        `Telegram sendPhoto failed: ${JSON.stringify(response.data)}`,
      );
    }
  }

  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<void> {
    const apiUrl = await this.getApiUrl();
    const absolutePath = path.resolve(filePath);

    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Document file not found: ${absolutePath}`);
    }

    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', fs.createReadStream(absolutePath));
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
    }

    const response = await axios.post(`${apiUrl}/sendDocument`, form, {
      headers: form.getHeaders(),
      timeout: 60000,
    });

    if (!response.data?.ok) {
      throw new Error(
        `Telegram sendDocument failed: ${JSON.stringify(response.data)}`,
      );
    }
  }
}
