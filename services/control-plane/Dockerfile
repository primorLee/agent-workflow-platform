FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY cloud ./cloud
RUN mkdir -p /app/var
ENV AWP_HOST=127.0.0.1 AWP_PORT=8100 AWP_DATA_DIR=/app/var
EXPOSE 8100
CMD ["python", "cloud/server.py"]
