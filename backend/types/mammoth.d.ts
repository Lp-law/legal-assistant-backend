declare module "mammoth" {
  interface ExtractRawTextResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }

  export function extractRawText(options: { buffer: Buffer }): Promise<ExtractRawTextResult>;
}

