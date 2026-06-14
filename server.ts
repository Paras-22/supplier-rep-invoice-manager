import express from "express";
import path from "path";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";

// Load environment variables
dotenv.config();

const app = express();
const PORT = 3000;

// Body parser configuration with large threshold for image base64 processing
app.use(express.json({ limit: "25mb" }));

// Initialize Gemini client (server-side only)
let ai: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!ai) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required but missing.");
    }
    ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return ai;
}

// REST Endpoint: Extract Invoice / Docket data using Gemini-3.5-Flash
app.post("/api/scan-invoice", async (req, res) => {
  try {
    const { fileData, mimeType } = req.body;
    if (!fileData || !mimeType) {
      return res.status(400).json({ error: "Missing fileData (base64) or mimeType in request body." });
    }

    const gemini = getGeminiClient();

    const imagePart = {
      inlineData: {
        mimeType,
        data: fileData,
      },
    };

    const promptText = `
      You are an expert OCR and invoice analyzer for Auckland supermarkets.
      Analyze the uploaded docket/invoice photo or file carefully.
      Extract information strictly matching the structural JSON requirements.
      - Extract 'supplierName' as the corporate supplier name (e.g. 'Coca-Cola', 'Frucor', 'Bidfood', 'Gilmours', etc.).
      - Extract 'invoiceDate' (prefer format 'YYYY-MM-DD', but fall back to raw string if unsure).
      - Extract 'repName' if a sales rep name is explicitly visible on the page (e.g. John Smith, etc.), else provide null or empty string.
      - Extract 'totalAmount' representing the final or grand total on the invoice.
      - Extract all 'items' representing products purchased. For each item:
        - 'name': full product/item description (clean up spelling, e.g. 'Coke Can 330ml 24 Pack').
        - 'code': any barcode, SKU or Idealpos product code shown, else null.
        - 'quantity': count of cases or units purchased.
        - 'price': wholesale cost per single unit/item. Calculate this if only aggregate line price is visible (e.g. if 2 items cost $10 total, the unit price is $5.00). Ensure accuracy.
    `;

    const response = await gemini.models.generateContent({
      model: "gemini-3.5-flash",
      contents: [imagePart, { text: promptText }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            supplierName: { type: Type.STRING, description: "Name of the supplier or brand." },
            invoiceDate: { type: Type.STRING, description: "Date of the invoice/docket." },
            repName: { type: Type.STRING, description: "Rep name if visible, or null." },
            totalAmount: { type: Type.NUMBER, description: "Overall total printed amount." },
            items: {
              type: Type.ARRAY,
              description: "Array of products in the invoice.",
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING, description: "Product description." },
                  code: { type: Type.STRING, description: "SKU or barcode if any." },
                  quantity: { type: Type.NUMBER, description: "Quantity purchased." },
                  price: { type: Type.NUMBER, description: "Wholesale individual unit cost." }
                },
                required: ["name", "quantity", "price"]
              }
            }
          },
          required: ["supplierName", "totalAmount", "items"]
        }
      }
    });

    const parsedText = response.text;
    if (!parsedText) {
      throw new Error("Empty OCR/information extracted from the image.");
    }

    try {
      const extractedJson = JSON.parse(parsedText);
      return res.json({ success: true, data: extractedJson });
    } catch {
      return res.status(200).json({
        success: true,
        data: {
          supplierName: "Unknown Supplier",
          invoiceDate: new Date().toISOString().split("T")[0],
          repName: null,
          totalAmount: 0,
          items: [],
          rawText: parsedText
        }
      });
    }

  } catch (err: any) {
    console.error("Scanner API Error: ", err);
    return res.status(500).json({ error: err.message || "Failed to scan docket with Gemini." });
  }
});

// Setup development or production environment assets serving
async function startApp() {
  if (process.env.NODE_ENV !== "production") {
    console.log("Starting server in development mode...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("Starting server in production mode...");
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Supplier Rep Server and Client live on port ${PORT}`);
  });
}

startApp().catch((err) => {
  console.error("Failed to boot full-stack integration: ", err);
});
