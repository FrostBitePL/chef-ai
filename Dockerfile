FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["sh", "-c", "gunicorn culinary_assistant:app --bind 0.0.0.0:$PORT --timeout 180 --workers 1"]
