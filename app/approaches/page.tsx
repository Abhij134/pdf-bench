import React from 'react'
import Link from 'next/link'

export default function ApproachesPage() {
  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', paddingBottom: '60px', paddingTop: '32px' }}>
      <div style={{ marginBottom: '24px' }}>
        <Link href="/" style={{ color: 'var(--blue)', textDecoration: 'none', fontSize: '0.95rem', display: 'inline-flex', alignItems: 'center', gap: '4px', fontWeight: 500 }}>
          ← Back to Dashboard
        </Link>
      </div>

      <div style={{ marginBottom: '40px' }}>
        <h1 style={{ marginBottom: '12px', fontSize: '2.2rem', fontWeight: 700, letterSpacing: '-0.02em' }}>Approaches & Pricing Analysis</h1>
        <p style={{ color: 'var(--muted)', fontSize: '1.1rem', lineHeight: '1.6', maxWidth: '850px' }}>
          An architectural deep-dive into how Document Text Extraction works, cost breakdowns (₹), and how this platform helps evaluate, benchmark, and scale extraction models.
        </p>
      </div>

      <div className="card" style={{ marginBottom: '32px' }}>
        <h2 style={{ marginBottom: '16px', fontSize: '1.35rem', color: 'var(--accent)' }}>🎯 What This Project Is Capable Of</h2>
        <div style={{ lineHeight: '1.7', color: 'var(--text)' }}>
          <p style={{ marginBottom: '16px' }}>
            This platform is a <strong>complete Benchmarking & Evaluation Suite</strong> built specifically for assessing how well different engines extract text from complex PDF documents (such as multi-column resumes, financial reports with dense tables, and complex academic papers).
          </p>
          <ul style={{ paddingLeft: '24px', marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <li><strong>Intelligent Extraction:</strong> Parses raw PDFs using multiple diverse engines (Native Libraries, Open-Source GPU models, and Enterprise Cloud APIs) simultaneously for side-by-side comparison.</li>
            <li><strong>Automated Ground Truth (GT) Generation:</strong> Generates highly accurate baseline ground-truth text using state-of-the-art Vision-Language Models (VLMs), combined with a Human Review Queue to guarantee perfect reference text.</li>
            <li><strong>Granular Benchmarking:</strong> Compares extracted text against the verified ground truth using advanced algorithms (including Levenshtein distance, CER/WER, and fuzzy matching) to give precise accuracy metrics.</li>
            <li><strong>Critical Entity Detection:</strong> Automatically scans for and identifies missing critical data (like phone numbers, email addresses, and numerical figures) that weak extraction engines frequently drop or hallucinate.</li>
            <li><strong>Resource Orchestration:</strong> Runs demanding open-source ML models completely locally, utilizing sophisticated queueing systems (via <code>FileLock</code>) to prevent hardware crashes (OOM) while keeping extraction costs at zero.</li>
          </ul>
          <p style={{ color: 'var(--muted)', fontSize: '0.95rem' }}>
            By leveraging this platform, teams can make data-driven decisions on <em>which extraction engine to choose</em> based on their unique cost constraints, latency requirements, and accuracy thresholds.
          </p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '32px' }}>
        <div className="card-title" style={{ marginBottom: '24px' }}>💵 Engine Pricing & Scaling Matrix</div>
        <p style={{ marginBottom: '16px', color: 'var(--muted)', fontSize: '0.9rem' }}>
          Assuming 1 Resume = 1 Page. Conversion rate used: ₹84 = $1 USD.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ENGINE</th>
                <th>TYPE</th>
                <th>COST PER PAGE (INR)</th>
                <th>100 PAGES (INR)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>GOOGLE_DOCUMENT_AI</strong></td>
                <td>Cloud API</td>
                <td>₹0.126 <span style={{fontSize:'0.8em', color:'var(--muted)'}}>($0.0015)</span></td>
                <td>₹12.60</td>
              </tr>
              <tr>
                <td><strong>MISTRAL_OCR</strong></td>
                <td>Cloud API</td>
                <td>₹0.084 <span style={{fontSize:'0.8em', color:'var(--muted)'}}>($0.0010)</span></td>
                <td>₹8.40</td>
              </tr>
              <tr>
                <td><strong>MARKER</strong></td>
                <td>Self-Hosted GPU</td>
                <td>~₹0.034 <span style={{fontSize:'0.8em', color:'var(--muted)'}}>(Compute)</span></td>
                <td>~₹3.40</td>
              </tr>
              <tr>
                <td><strong>PYMUPDF / PDFMINER</strong></td>
                <td>Native Library</td>
                <td>₹0.00</td>
                <td>₹0.00</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '32px' }}>
        <h2 style={{ marginBottom: '20px', fontSize: '1.25rem' }}>🔍 Evaluated VLM / OCR Approaches</h2>
        <div style={{ display: 'grid', gap: '20px' }}>
          
          <div style={{ padding: '16px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid var(--border)' }}>
            <h3 style={{ marginBottom: '8px', color: 'var(--blue)' }}>Marker & Surya (Current Backend Engine)</h3>
            <p style={{ marginBottom: '8px' }}><strong>Type:</strong> 100% Free / Open Source (Local Execution)</p>
            <p style={{ lineHeight: '1.6' }}>
              The current absolute best non-LLM open-source tool for converting complex PDFs into Markdown. It utilizes deep learning (Surya) to detect text boxes, reading order, and table boundaries before running OCR. It perfectly preserves reading order and handles multi-column layouts automatically. It runs completely locally, meaning <strong>Zero API Costs</strong>. However, it requires a dedicated GPU for acceptable speeds and consumes ~3-4GB of VRAM.
            </p>
          </div>

          <div style={{ padding: '16px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid var(--border)' }}>
            <h3 style={{ marginBottom: '8px', color: 'var(--orange)' }}>Ollama + Llama 3.2-Vision (11B)</h3>
            <p style={{ marginBottom: '8px' }}><strong>Type:</strong> 100% Free (Local VLM)</p>
            <p style={{ lineHeight: '1.6' }}>
              Meta's newest open-weights Vision Language Model. By installing Ollama, this can run locally on your machine. It provides Gemini-like reasoning (e.g. "Extract all text preserving tables") entirely for free. While it possesses incredible reasoning capabilities, it occasionally struggles with dense tables or highly fragmented resumes compared to purpose-built pipelines like Marker.
            </p>
          </div>

          <div style={{ padding: '16px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid var(--border)' }}>
            <h3 style={{ marginBottom: '8px', color: 'var(--green)' }}>Qwen2-VL</h3>
            <p style={{ marginBottom: '8px' }}><strong>Type:</strong> Free (Local) or Paid API (e.g. Together AI)</p>
            <p style={{ lineHeight: '1.6' }}>
              Currently the industry-leading open-weights Vision model for pure OCR and document understanding. It frequently beats Gemini and Claude on text-extraction benchmarks due to its dynamic resolution processing. It can be run locally via vLLM (requiring substantial VRAM) or accessed very cheaply via cloud inference APIs.
            </p>
          </div>

          <div style={{ padding: '16px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid var(--border)' }}>
            <h3 style={{ marginBottom: '8px', color: 'var(--purple)' }}>Azure Document Intelligence</h3>
            <p style={{ marginBottom: '8px' }}><strong>Type:</strong> Paid Enterprise API</p>
            <p style={{ lineHeight: '1.6' }}>
              The industry gold standard for complex PDFs, forms, and reading order when you strictly need extraction without conversational AI. Highly accurate, reliable, and compliant, but proprietary and paid (approx. ₹125 per 100 pages, though a generous 500-page free tier exists for testing).
            </p>
          </div>

        </div>
      </div>

      <div className="card" style={{ marginBottom: '32px' }}>
        <h2 style={{ marginBottom: '20px', fontSize: '1.25rem' }}>⚙️ Current Architecture: How it Works</h2>
        <div style={{ lineHeight: '1.7', color: 'var(--text)' }}>
          <p style={{ marginBottom: '16px' }}>
            To generate <strong>Ground Truth</strong> safely and for free, we are utilizing the <strong>Marker</strong> approach integrated with a Next.js full-stack framework. Here is how the systems interact:
          </p>
          <ul style={{ paddingLeft: '24px', marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <li><strong>Isolated Python Environment:</strong> Marker and its AI dependencies are installed in a dedicated Python 3.12 virtual environment (<code>.venv</code>). The Next.js Node server uses <code>child_process.spawn</code> to execute python scripts natively, bridging the gap between web UI and ML models.</li>
            <li><strong>Persistent Model Caching:</strong> All massive PyTorch models (3GB+) are downloaded directly to your local file system, ensuring subsequent extractions don't require heavy network usage.</li>
            <li><strong>Concurrency Protection (Queuing):</strong> Because loading ML models is highly RAM-intensive, we implemented a sophisticated <code>FileLock</code> queue in the backend. If you batch-process 20 resumes at once via the "Run Benchmark" UI, the system forces the Python worker to process them sequentially one-by-one. This prevents your computer from crashing due to Out-of-Memory (OOM) errors.</li>
          </ul>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: '20px', fontSize: '1.25rem' }}>🚀 Adding Future Approaches</h2>
        <p style={{ lineHeight: '1.6', marginBottom: '16px' }}>
          The benchmarking system is modular and designed to easily accept new engines with minimal friction. If you wish to add <strong>Ollama (Llama 3.2-Vision)</strong> or <strong>Qwen2-VL</strong> in the future, follow these steps:
        </p>
        <ol style={{ paddingLeft: '24px', lineHeight: '1.6', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <li><strong>Create the Engine Script:</strong> Create a new file like <code>workers/engines/ollama_engine.py</code>. Have it subclass our standardized <code>BaseEngine</code> interface.</li>
          <li><strong>Implement Extraction:</strong> Write the logic to convert the PDF to images (using something like <code>pdf2image</code>) and send a POST request to your local Ollama instance (<code>http://localhost:11434/api/generate</code>).</li>
          <li><strong>Register the Engine:</strong> Add the new engine Enum to the Prisma database schema, and register the script hook in the router inside <code>workers/engine_runner.py</code>. The UI will automatically detect the new engine and make it available for benchmarking!</li>
        </ol>
      </div>

    </div>
  )
}
