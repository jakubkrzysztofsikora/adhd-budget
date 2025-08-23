"""
Transaction Categorizer Module
Implements T3 Gate: Categorization accuracy ≥80%
"""

from typing import Dict, List


class TransactionCategorizer:
    """Categorizes transactions based on merchant and description"""
    
    CATEGORY_RULES = {
        'groceries': ['tesco', 'sainsbury', 'asda', 'lidl', 'aldi', 'market', 'coop', 'co-op'],
        'eating_out': ['restaurant', 'cafe', 'pizza', 'burger', 'pub', 'bar', 'coffee', 
                       'deliveroo', 'uber eats', 'just eat', 'nando', 'nandos', 'costa', 
                       'starbucks', 'pret'],
        'transport': ['uber', 'taxi', 'bus', 'train', 'petrol', 'fuel', 'parking', 
                      'shell', 'bp', 'esso', 'tfl', 'transport for london'],
        'bills': ['electricity', 'gas', 'water', 'internet', 'phone', 'insurance', 
                  'british gas', 'vodafone', 'ee', 'broadband', 'council', 'council tax',
                  'thames water', 'admiral'],
        'entertainment': ['netflix', 'spotify', 'cinema', 'theatre', 'steam', 'xbox', 
                          'playstation', 'disney', 'amazon prime', 'vue', 'holiday inn'],
        'shopping': ['amazon', 'ebay', 'asos', 'zara', 'h&m', 'primark', 'next', 'argos'],
        'health': ['pharmacy', 'doctor', 'dentist', 'gym', 'fitness', 'boots', 'pure gym'],
        'rent': ['rent', 'lease', 'landlord', 'property management'],
    }
    
    def categorize(self, transaction: Dict) -> str:
        """
        Categorize a transaction based on merchant and description
        
        Args:
            transaction: Dict with 'merchant' and 'description' fields
            
        Returns:
            Category string
        """
        if transaction is None:
            return 'other'
            
        # Handle edge cases
        description = transaction.get('description', '')
        merchant = transaction.get('merchant', '')
        
        if description is None:
            description = ''
        if merchant is None:
            merchant = ''
            
        description = description.lower()
        merchant = merchant.lower()
        
        # Check against rules
        for category, keywords in self.CATEGORY_RULES.items():
            for keyword in keywords:
                if keyword in description or keyword in merchant:
                    return category
        
        return 'other'