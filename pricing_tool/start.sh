#!/bin/bash
# Uruchom aplikację LV Inteligentne Ofertowanie

cd "$(dirname "$0")"

# Instalacja zależności jeśli brakuje
pip3 install -q -r requirements.txt

# Uruchom aplikację
python3 -m streamlit run app.py --server.port 8501
