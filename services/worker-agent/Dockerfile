FROM python:3.12-slim
WORKDIR /worker
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY agent.py cloud_client.py config.py storage.py agent.yaml.example ./
RUN cp agent.yaml.example agent.yaml
CMD ["python", "agent.py", "--config", "agent.yaml"]