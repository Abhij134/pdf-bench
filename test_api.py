from openai import OpenAI

client = OpenAI(
    base_url="https://co.agentrouter.org/v1",
    api_key="sk-your-actual-long-copied-key-goes-here"
)

try:
    response = client.chat.completions.create(
        model="deepseek-v4-flash",
        messages=[{"role": "user", "content": "Reply with exactly: 'API is working!'"}]
    )
    print(response.choices[0].message.content)
except Exception as e:
    print(f"Connection failed: {e}")