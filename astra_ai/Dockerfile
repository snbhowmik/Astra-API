# Use an official Python runtime as a parent image
FROM python:3.10-slim

# Set the working directory in the container
WORKDIR /app

# Copy the requirements file first and install dependencies
# This is a Docker best-practice for layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 5000

# Command to run the application
# We use --host 0.0.0.0 to make it accessible to other containers
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5000"]