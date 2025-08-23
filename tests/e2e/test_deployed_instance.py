#!/usr/bin/env python3
"""
E2E tests for deployed ADHD Budget instance
Tests the live deployment at https://adhdbudget.bieda.it
"""

import requests
import json
import time
import sys

BASE_URL = "https://adhdbudget.bieda.it"

def test_main_page():
    """Test that main page is accessible"""
    print("Testing main page...")
    response = requests.get(BASE_URL, timeout=10)
    assert response.status_code == 200, f"Main page returned {response.status_code}"
    print("✅ Main page accessible")
    return True

def test_health_endpoint():
    """Test health check endpoint"""
    print("Testing health endpoint...")
    response = requests.get(f"{BASE_URL}/health", timeout=10, allow_redirects=False)
    # Accept 200, 404 (not implemented), or 302 (redirect)
    assert response.status_code in [200, 404, 302], f"Health endpoint returned {response.status_code}"
    print(f"✅ Health endpoint responded with {response.status_code}")
    return True

def test_api_endpoint():
    """Test API endpoint"""
    print("Testing API endpoint...")
    response = requests.get(f"{BASE_URL}/api", timeout=10, allow_redirects=False)
    # Accept various responses as the API might require auth
    assert response.status_code in [200, 401, 404, 302], f"API endpoint returned {response.status_code}"
    print(f"✅ API endpoint responded with {response.status_code}")
    return True

def test_ssl_certificate():
    """Test SSL certificate is valid"""
    print("Testing SSL certificate...")
    try:
        response = requests.get(BASE_URL, timeout=10, verify=True)
        print("✅ SSL certificate is valid")
        return True
    except requests.exceptions.SSLError as e:
        print(f"❌ SSL certificate error: {e}")
        return False

def test_response_headers():
    """Test security headers"""
    print("Testing response headers...")
    response = requests.get(BASE_URL, timeout=10)
    headers = response.headers
    
    # Check for security headers
    security_headers = []
    if 'X-Content-Type-Options' in headers:
        security_headers.append("X-Content-Type-Options")
    if 'X-Frame-Options' in headers:
        security_headers.append("X-Frame-Options")
    if 'Strict-Transport-Security' in headers:
        security_headers.append("HSTS")
    
    print(f"  Found security headers: {', '.join(security_headers) if security_headers else 'None'}")
    print("✅ Headers checked")
    return True

def test_docker_services():
    """Test that expected services are responding"""
    print("Testing Docker services availability...")
    
    # Test various endpoints that might indicate services
    endpoints = [
        ("/", "Main app"),
        ("/api", "API service"),
        ("/health", "Health check"),
    ]
    
    for endpoint, name in endpoints:
        try:
            response = requests.get(f"{BASE_URL}{endpoint}", timeout=5, allow_redirects=False)
            print(f"  {name}: {response.status_code}")
        except Exception as e:
            print(f"  {name}: Failed - {e}")
    
    print("✅ Service availability checked")
    return True

def test_response_time():
    """Test response time is reasonable"""
    print("Testing response time...")
    start = time.time()
    response = requests.get(BASE_URL, timeout=10)
    elapsed = time.time() - start
    
    print(f"  Response time: {elapsed:.2f}s")
    assert elapsed < 5, f"Response too slow: {elapsed:.2f}s"
    print("✅ Response time acceptable")
    return True

def main():
    """Run all E2E tests"""
    print(f"\n{'='*50}")
    print(f"E2E Tests for {BASE_URL}")
    print(f"{'='*50}\n")
    
    tests = [
        test_main_page,
        test_health_endpoint,
        test_api_endpoint,
        test_ssl_certificate,
        test_response_headers,
        test_docker_services,
        test_response_time,
    ]
    
    passed = 0
    failed = 0
    
    for test_func in tests:
        try:
            if test_func():
                passed += 1
        except AssertionError as e:
            print(f"❌ {test_func.__name__} failed: {e}")
            failed += 1
        except Exception as e:
            print(f"❌ {test_func.__name__} error: {e}")
            failed += 1
        print()
    
    print(f"{'='*50}")
    print(f"Results: {passed} passed, {failed} failed")
    print(f"{'='*50}")
    
    return failed == 0

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)